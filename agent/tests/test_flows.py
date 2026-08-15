from datetime import datetime, timedelta, timezone
from unittest import TestCase
from unittest.mock import patch
import json

from scapy.layers.inet import ICMP, IP, TCP, UDP
from scapy.packet import Raw

from network_monitoring_agent.flows import FlowAggregator, extract_packet_metadata
from network_monitoring_agent.traffic_live import resolve_capture_interface


class FlowExtractionTest(TestCase):
    def test_extract_tcp_udp_and_icmp_header_metadata_only(self):
        now = datetime.now(timezone.utc).timestamp()
        packets = [
            IP(src="10.0.0.1", dst="10.0.0.2") / TCP(sport=1234, dport=443) / Raw(b"secret"),
            IP(src="10.0.0.2", dst="10.0.0.3") / UDP(sport=5353, dport=53),
            IP(src="10.0.0.3", dst="10.0.0.4") / ICMP(),
        ]
        for packet in packets: packet.time = now
        tcp, udp, icmp = [extract_packet_metadata(packet) for packet in packets]
        self.assertEqual((tcp.src_ip, tcp.dst_ip, tcp.src_port, tcp.dst_port, tcp.protocol), ("10.0.0.1", "10.0.0.2", 1234, 443, "tcp"))
        self.assertEqual((udp.src_port, udp.dst_port, udp.protocol), (5353, 53, "udp"))
        self.assertEqual((icmp.src_port, icmp.dst_port, icmp.protocol), (None, None, "icmp"))
        self.assertEqual(tcp.size_bytes, len(packets[0]))
        self.assertTrue(tcp.timestamp.endswith("Z"))
        self.assertNotIn("secret", repr(tcp))
        self.assertFalse(hasattr(tcp, "payload"))

    def test_unsupported_packet_is_ignored(self):
        self.assertIsNone(extract_packet_metadata(Raw(b"not ip")))
        self.assertIsNone(extract_packet_metadata(object()))

    def test_directional_aggregation_status_expiry_and_rollups(self):
        now = datetime.now(timezone.utc)
        agg = FlowAggregator()
        def meta(src, dst, size, seconds=0):
            return type("M", (), {"src_ip":src,"dst_ip":dst,"src_port":1000,"dst_port":443,
                                  "protocol":"tcp","size_bytes":size,"timestamp":(now-timedelta(seconds=seconds)).isoformat()})()
        agg.observe(meta("10.0.0.1", "10.0.0.2", 1000))
        agg.observe(meta("10.0.0.2", "10.0.0.1", 500, 10))
        snap = agg.snapshot(now, 2)
        self.assertEqual(len(snap["flows"]), 2)
        self.assertEqual({row["status"] for row in snap["flows"]}, {"active", "idle"})
        self.assertEqual(snap["conversations"][0]["total_bytes"], 1500)
        self.assertEqual(snap["conversations"][0]["active_flows"], 1)
        self.assertEqual(snap["summary"]["packets_per_second"], 1.0)
        self.assertEqual(snap["top_talkers"][0]["ip"], "10.0.0.1")
        self.assertEqual(snap["top_talkers"][0]["active_flows"], 1)
        self.assertEqual(agg.snapshot(now + timedelta(seconds=31), 2)["flows"], [])

    def test_thousands_of_packets_coalesce_into_one_flow(self):
        now = datetime.now(timezone.utc)
        agg = FlowAggregator()
        packet = IP(src="192.0.2.1", dst="192.0.2.2") / UDP(sport=5000, dport=5001)
        packet.time = now.timestamp()
        metadata = extract_packet_metadata(packet)
        for _ in range(5000): agg.observe(metadata)
        row = agg.snapshot(now, 2)["flows"][0]
        self.assertEqual(row["packet_count"], 5000)
        self.assertEqual(row["total_bytes"], len(packet) * 5000)

    def test_bounded_snapshot_stays_under_backend_limit(self):
        now = datetime.now(timezone.utc)
        agg = FlowAggregator(max_flows=100, max_states=100)
        for index in range(100):
            src = f"10.0.{index // 250}.{index % 250 + 1}"
            item = type("M", (), {"src_ip":src,"dst_ip":"192.0.2.1","src_port":1000+index,
                                  "dst_port":443,"protocol":"tcp","size_bytes":1500,"timestamp":now.isoformat()})()
            agg.observe(item)
        snapshot = agg.snapshot(now, 2)
        self.assertEqual(len(snapshot["flows"]), 100)
        self.assertLessEqual(len(json.dumps(snapshot, separators=(",", ":")).encode()), 65536)

    @patch("network_monitoring_agent.traffic_live.psutil.net_if_addrs")
    def test_auto_interface_ignores_loopback_and_link_local(self, addresses):
        import socket
        address = lambda family, value: type("Address", (), {"family":family,"address":value})()
        addresses.return_value = {"lo":[address(socket.AF_INET,"127.0.0.1")],"loopback0":[address(socket.AF_INET,"169.254.1.2")],"dynamic0":[address(socket.AF_INET,"192.168.1.62")]}
        self.assertEqual(resolve_capture_interface("auto_ipv4"), "dynamic0")

    @patch("network_monitoring_agent.traffic_live.psutil.net_if_addrs")
    def test_auto_interface_fails_safe_when_ambiguous(self, addresses):
        import socket
        address = lambda value: type("Address", (), {"family":socket.AF_INET,"address":value})()
        addresses.return_value = {"one":[address("10.0.0.1")],"two":[address("192.168.1.2")]}
        with self.assertRaises(ValueError): resolve_capture_interface("auto_ipv4")
