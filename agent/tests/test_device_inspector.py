import json
import struct
import time
from contextlib import redirect_stdout
from io import StringIO
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace

from network_monitoring_agent.device_inspector import (
    TCP_PORTS,
    INSPECTION_BUDGET_SECONDS,
    InspectionDeadlineExceeded,
    classify_device,
    http_metadata,
    inspect_device,
    inspector_capabilities,
    is_locally_administered,
    netbios_metadata,
    tls_metadata,
    upnp_metadata,
)
from network_monitoring_agent.main import main


class DeviceInspectorClassifierTest(TestCase):
    def test_router_gateway_fixture(self) -> None:
        result = classify_device({
            "ip": "192.168.188.50", "reachable": True,
            "route_role": "default_gateway", "same_subnet": True,
            "mac": "EC:75:0C:BE:85:50", "mac_kind": "global",
            "mac_vendor": "TP-Link Systems", "open_ports": [80, 443],
            "http": {"server": "BusyBox HTTP"},
            "tls": {"common_name": "tplinkwifi.net"},
            "upnp": {
                "deviceType": "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                "friendlyName": "Archer AX53", "manufacturer": "TP-Link",
                "modelName": "Archer AX53", "modelNumber": "1.0",
                "service_types": ["urn:schemas-upnp-org:service:Layer3Forwarding:1"],
            },
        })
        self.assertEqual(result["detected_identity"]["manufacturer"], "TP-Link")
        self.assertEqual(result["detected_identity"]["model"], "Archer AX53")
        self.assertEqual(result["detected_identity"]["model_number"], "1.0")
        self.assertNotIn("hardware_revision", result["detected_identity"])
        self.assertEqual(result["likely_device_type"], "router")
        self.assertEqual(result["confidence"], "high")
        self.assertEqual(
            set(result["capabilities"]),
            {"gateway", "wifi_ap", "upnp", "layer3_forwarding"},
        )

    def test_windows_laragon_fixture_does_not_use_nic_vendor_as_manufacturer(self) -> None:
        result = classify_device({
            "ip": "192.168.188.111", "reachable": True,
            "route_role": "on_link", "same_subnet": True,
            "mac": "00:11:22:33:44:55", "mac_kind": "global",
            "mac_vendor": "Intel Corporate", "open_ports": [80, 443, 445],
            "http": {"server": "Apache/2.4.54 (Win64) OpenSSL/1.1.1q PHP/8.1.10", "title": "Laragon"},
            "tls": {}, "upnp": {},
        })
        self.assertEqual(result["likely_device_type"], "workstation")
        self.assertEqual(result["detected_identity"]["os_family"], "Windows")
        self.assertIsNone(result["detected_identity"]["manufacturer"])
        self.assertEqual(set(result["observed_software"]), {"Apache/2.4.54", "Laragon", "OpenSSL/1.1.1q", "PHP/8.1.10"})
        self.assertEqual(result["confidence"], "medium")

    def test_poliklinikk_like_fixture_remains_partial_low_confidence(self) -> None:
        result = classify_device({
            "ip": "192.168.188.249", "reachable": True,
            "route_role": "on_link", "same_subnet": True,
            "mac": "BC:17:B8:26:11:D7", "mac_kind": "global",
            "mac_vendor": "Intel Corporate", "open_ports": [445],
            "tcp_states": [{"name": "SMB", "protocol": "tcp", "port": 445, "state": "open"}],
            "http": [], "tls": [], "upnp": {}, "netbios": {},
        })
        self.assertIsNone(result["detected_identity"]["manufacturer"])
        self.assertIsNone(result["detected_identity"]["model"])
        self.assertEqual(result["likely_device_type"], "unknown")
        self.assertEqual(result["confidence"], "low")
        self.assertEqual(result["probe_summary"]["tcp_states"][0]["state"], "open")

    def test_randomized_mac_is_not_vendor_evidence(self) -> None:
        self.assertTrue(is_locally_administered("02:11:22:33:44:55"))
        result = classify_device({
            "ip": "192.168.188.100", "reachable": True,
            "route_role": "on_link", "same_subnet": True,
            "mac": "02:11:22:33:44:55", "mac_kind": "locally_administered",
            "mac_vendor": "Should Not Survive", "open_ports": [],
            "http": {}, "tls": {}, "upnp": {},
        })
        self.assertIsNone(result["network_identity"]["mac_vendor"])
        self.assertEqual(result["confidence"], "unknown")

    def test_unknown_reachable_host_remains_unknown(self) -> None:
        result = classify_device({
            "ip": "192.168.188.101", "reachable": True, "route_role": "on_link",
            "same_subnet": True, "mac": None, "mac_kind": "unavailable",
            "mac_vendor": None, "open_ports": [], "http": {}, "tls": {}, "upnp": {},
        })
        self.assertEqual(result["likely_device_type"], "unknown")
        self.assertEqual(result["confidence"], "unknown")

    @patch("network_monitoring_agent.device_inspector.upnp_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.tls_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.http_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_routed_target_never_retains_gateway_mac(self, *_mocks) -> None:
        result = inspect_device("192.168.112.1", {
            "route_role": "routed", "same_subnet": False,
            "mac": "EC:75:0C:BE:85:50", "reachable": True,
            "is_this_device": False, "interface_index": 20,
            "interface_alias": "Wi-Fi", "interface_description": "MediaTek Wi-Fi",
            "interface_type": "physical",
        })
        self.assertIsNone(result["network_identity"]["mac"])
        self.assertIn("Target is routed", " ".join(result["limitations"]))

    def test_probe_plan_is_fixed_and_small(self) -> None:
        self.assertEqual(TCP_PORTS, (22, 80, 443, 445, 554, 631, 1883, 8080, 8443, 9100))
        self.assertEqual(len(TCP_PORTS), 10)
        self.assertEqual(INSPECTION_BUDGET_SECONDS, 24.5)

    @patch("network_monitoring_agent.device_inspector.upnp_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_normal_fast_completion_is_not_marked_partial(self, *_mocks) -> None:
        result = inspect_device("192.168.188.20", {
            "route_role": "on_link", "same_subnet": True, "mac": None,
            "reachable": True, "is_this_device": False, "interface_index": 20,
            "interface_alias": "Wi-Fi", "interface_description": "Adapter",
            "interface_type": "physical",
        })
        self.assertFalse(result["probe_summary"]["partial"])

    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_slow_optional_collector_returns_partial_existing_evidence(self, _tcp) -> None:
        def slow_upnp(*_args, **_kwargs):
            time.sleep(0.08)
            return None

        with patch("network_monitoring_agent.device_inspector.upnp_metadata", side_effect=slow_upnp):
            started = time.monotonic()
            result = inspect_device("192.168.188.20", {
                "route_role": "on_link", "same_subnet": True, "mac": None,
                "reachable": True, "is_this_device": False, "interface_index": 20,
                "interface_alias": "Wi-Fi", "interface_description": "Adapter",
                "interface_type": "physical",
            }, total_budget_seconds=0.03)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertTrue(result["probe_summary"]["partial"])
        self.assertIn("deadline", result["probe_summary"]["optional_skips"])

    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_deadline_before_usable_evidence_is_bounded_timeout(self, _tcp) -> None:
        def slow_upnp(*_args, **_kwargs):
            time.sleep(0.08)
            return None

        with patch("network_monitoring_agent.device_inspector.upnp_metadata", side_effect=slow_upnp):
            with self.assertRaises(InspectionDeadlineExceeded):
                inspect_device("192.168.188.20", {
                    "route_role": "on_link", "same_subnet": True, "mac": None,
                    "reachable": False, "is_this_device": False, "interface_index": 20,
                    "interface_alias": "Wi-Fi", "interface_description": "Adapter",
                    "interface_type": "physical",
                }, total_budget_seconds=0.03)

    @patch("network_monitoring_agent.device_inspector.shutil.which", return_value=None)
    def test_capabilities_do_not_require_nmap_or_optional_tools(self, _which) -> None:
        capabilities = inspector_capabilities()
        self.assertTrue(capabilities["available"])
        self.assertEqual(capabilities["probe_engine"], "python_socket")
        self.assertFalse(capabilities["available_but_unused"]["nmap"])
        self.assertFalse(capabilities["optional"]["openssl"])
        self.assertTrue(capabilities["collectors"]["netbios_node_status"])

    @patch("network_monitoring_agent.device_inspector.upnp_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.tls_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.http_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.netbios_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[{"name": "SMB", "protocol": "tcp", "port": 445, "state": "open"}])
    def test_missing_optional_metadata_still_returns_partial_fingerprint(self, *_mocks) -> None:
        result = inspect_device("192.168.188.249", {
            "route_role": "on_link", "same_subnet": True,
            "mac": None, "reachable": True,
            "is_this_device": False, "interface_index": 20,
            "interface_alias": "Wi-Fi", "interface_description": "MediaTek Wi-Fi",
            "interface_type": "physical",
        })
        self.assertEqual(result["likely_device_type"], "unknown")
        self.assertEqual(result["observed_services"][0]["name"], "SMB")

    def test_rejected_upnp_location_is_normalized_without_becoming_identity(self) -> None:
        result = classify_device({
            "ip": "192.168.188.50", "reachable": True, "route_role": "default_gateway",
            "same_subnet": True, "mac": None, "mac_kind": "unavailable", "mac_vendor": None,
            "open_ports": [], "http": [], "tls": [],
            "upnp": {"detected": True, "location_rejected": True, "rejection_reason": "unsafe_location"},
        })
        self.assertIsNone(result["detected_identity"]["manufacturer"])
        self.assertTrue(any("rejected" in item["value"] for item in result["evidence"]))

    @patch("network_monitoring_agent.device_inspector.socket.gethostbyname", return_value="203.0.113.9")
    @patch("network_monitoring_agent.device_inspector.socket.create_connection")
    @patch("network_monitoring_agent.device_inspector.socket.socket")
    def test_upnp_never_fetches_external_location(self, socket_factory, create_connection, _resolve) -> None:
        udp = socket_factory.return_value.__enter__.return_value
        udp.recvfrom.return_value = (
            b"HTTP/1.1 200 OK\r\nLOCATION: http://evil.example/device.xml\r\n\r\n",
            ("192.168.188.50", 1900),
        )
        result = upnp_metadata("192.168.188.50")
        self.assertTrue(result["location_rejected"])
        create_connection.assert_not_called()

    @patch("network_monitoring_agent.device_inspector.socket.create_connection")
    def test_http_metadata_is_bounded_and_does_not_follow_redirect(self, create_connection) -> None:
        connection = create_connection.return_value.__enter__.return_value
        connection.recv.side_effect = [
            b"HTTP/1.1 302 Found\r\nServer: UnitTest\r\nContent-Type: text/html\r\nLocation: http://user:secret@192.168.1.8/next?token=hidden\r\n\r\n<title>Move</title>",
            b"",
        ]
        result = http_metadata("192.168.1.8", 80)
        self.assertEqual(result["status"], 302)
        self.assertEqual(result["location"], "http://192.168.1.8/next")
        self.assertEqual(create_connection.call_count, 1)

    @patch("network_monitoring_agent.device_inspector.shutil.which", return_value="/usr/bin/openssl")
    @patch("network_monitoring_agent.device_inspector.subprocess.run")
    def test_tls_metadata_normalizes_cn_san_issuer_and_validity(self, run, _which) -> None:
        run.side_effect = [
            SimpleNamespace(stdout="-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", returncode=0),
            SimpleNamespace(stdout=(
                "subject=CN=tplinkwifi.net\nissuer=CN=TP-Link Local CA\n"
                "notBefore=Aug 1 00:00:00 2026 GMT\nnotAfter=Aug 1 00:00:00 2036 GMT\n"
                "X509v3 Subject Alternative Name:\n    DNS:tplinkwifi.net, DNS:router.local\n"
            ), returncode=0),
        ]
        result = tls_metadata("192.168.188.50", 443)
        self.assertEqual(result["common_name"], "tplinkwifi.net")
        self.assertEqual(result["subject_alt_names"], ["tplinkwifi.net", "router.local"])
        self.assertEqual(result["issuer"], "CN=TP-Link Local CA")

    @patch("network_monitoring_agent.device_inspector.socket.socket")
    def test_netbios_node_status_returns_only_hostname(self, socket_factory) -> None:
        name = b"POLIKLINIKK".ljust(15, b" ") + b"\x00" + b"\x00\x00"
        rdata = b"\x01" + name + b"\x00\x11\x22\x33\x44\x55"
        question_name = b"\x20" + (b"A" * 32) + b"\x00"
        response = struct.pack("!HHHHHH", 0x4E4D, 0x8500, 1, 1, 0, 0)
        response += question_name + struct.pack("!HH", 0x21, 1)
        response += b"\xc0\x0c" + struct.pack("!HHIH", 0x21, 1, 0, len(rdata)) + rdata
        udp = socket_factory.return_value.__enter__.return_value
        udp.recvfrom.return_value = (response, ("192.168.188.249", 137))
        self.assertEqual(netbios_metadata("192.168.188.249"), {"hostname": "POLIKLINIKK"})

    @patch("network_monitoring_agent.main._run_device_inspection")
    def test_cli_rejects_arbitrary_probe_flags(self, run_inspection) -> None:
        with self.assertRaises(SystemExit), redirect_stdout(StringIO()):
            main(["device-inspect", "192.168.1.1", "--route-role", "on_link",
                  "--same-subnet", "yes", "--reachable", "yes",
                  "--is-this-device", "no", "--interface-index", "20",
                  "--interface-alias", "Wi-Fi", "--interface-description", "MediaTek Wi-Fi",
                  "--interface-type", "physical", "--ports", "1-65535"])
        run_inspection.assert_not_called()

    def test_normalized_fixture_contains_no_raw_content_fields(self) -> None:
        result = classify_device({
            "ip": "192.168.1.2", "reachable": True, "route_role": "on_link",
            "same_subnet": True, "mac": None, "mac_kind": "unavailable",
            "mac_vendor": None, "open_ports": [80],
            "http": {"title": "Safe title"}, "tls": {}, "upnp": {},
        })
        serialized = json.dumps(result).lower()
        self.assertLess(len(serialized.encode("utf-8")), 32 * 1024)
        for prohibited in ('"stdout"', '"stderr"', '"html"', '"xml"', '"body"', '"payload"'):
            self.assertNotIn(prohibited, serialized)

    def test_self_physical_interface_is_this_device_without_overwriting_hardware_type(self) -> None:
        result = classify_device({
            "ip": "192.168.188.180", "reachable": True, "route_role": "on_link",
            "same_subnet": True, "is_this_device": True, "interface_index": 20,
            "interface_alias": "Wi-Fi", "interface_description": "MediaTek Wi-Fi 6 Adapter",
            "interface_type": "physical", "mac": None, "mac_kind": "unavailable",
            "mac_vendor": None, "open_ports": [], "http": [], "tls": [], "upnp": {},
        })
        self.assertEqual(result["network_context"]["automated_role"], "this_device")
        self.assertEqual(result["network_context"]["interface_type"], "physical")
        self.assertEqual(result["likely_device_type"], "unknown")
        self.assertEqual(result["detected_identity"]["likely_label"], "This Windows device")
        self.assertEqual(result["detected_identity"]["os_family"], "Windows")
        self.assertIn("local_host", result["capabilities"])

    def test_self_virtual_interface_is_labeled_without_hardcoded_ip(self) -> None:
        result = classify_device({
            "ip": "10.20.30.40", "reachable": True, "route_role": "on_link",
            "same_subnet": True, "is_this_device": True, "interface_index": 42,
            "interface_alias": "vEthernet (WSL)",
            "interface_description": "Hyper-V Virtual Ethernet Adapter",
            "interface_type": "virtual", "mac": None, "mac_kind": "unavailable",
            "mac_vendor": None, "open_ports": [], "http": [], "tls": [], "upnp": {},
        })
        self.assertEqual(result["detected_identity"]["likely_label"], "Local Windows virtual interface")
        self.assertIn("virtual_interface", result["capabilities"])
        self.assertEqual(result["network_context"]["interface_alias"], "vEthernet (WSL)")
