"""Deterministic mocked-SNMP tests for the managed telemetry collector.

No real SNMP device traffic is involved — the transport is always a
MockSnmpTransport fixture.
"""

from unittest import TestCase

from network_monitoring_agent.snmp_collector import (
    MAX_NETBIOS_ENRICHMENTS,
    NETBIOS_ENRICHMENT_CONCURRENCY,
    NETBIOS_ENRICHMENT_TIMEOUT_SECONDS,
    SnmpTelemetryPoll,
    collect_telemetry,
    is_physical_interface,
    snmp_telemetry_poll,
)
from network_monitoring_agent.snmp_transport import (
    OID_IF_TABLE,
    OID_IP_NET_TO_MEDIA,
    OID_IP_NET_TO_PHYSICAL,
    OID_SYSTEM,
    MockSnmpTransport,
    SnmpCredentials,
)

MGMT_IP = "192.0.2.10"


def _oid(column_oid: str, if_index: int) -> str:
    return f"{column_oid}.{if_index}"


def _build_24_port_switch(
    *,
    errors_rx: dict[int, int] | None = None,
    errors_tx: dict[int, int] | None = None,
    discards_in: dict[int, int] | None = None,
    discards_out: dict[int, int] | None = None,
    oper_down: set[int] | None = None,
    include_entity_mib: bool = True,
) -> dict[str, object]:
    """Fixture 1/2/3/10/11: a 24-port switch plus VLAN/Loopback/Port-channel."""
    responses: dict[str, object] = {}

    # System group
    responses[OID_SYSTEM["sysDescr"]] = "Cisco IOS Software, Catalyst 2960-X, C2960X-48TD"
    responses[OID_SYSTEM["sysObjectID"]] = "1.3.6.1.4.1.9.1.1894"
    responses[OID_SYSTEM["sysUpTime"]] = 2000  # 2000 ticks = 20 seconds uptime
    responses[OID_SYSTEM["sysName"]] = "core-switch-1"

    # Interfaces: 24 physical ports + VLAN 100 + Loopback0 + Port-channel1 + mgmt0
    interfaces = [(i, "GigabitEthernet1/0/%d" % i, 6, 1000000000) for i in range(1, 25)]
    interfaces.append((100, "Vlan100", 6, 1000000000))
    interfaces.append((101, "Loopback0", 24, 0))
    interfaces.append((102, "Port-channel1", 6, 1000000000))
    interfaces.append((103, "mgmt0", 24, 1000000000))

    for if_index, name, if_type, speed in interfaces:
        responses[_oid(OID_IF_TABLE["ifDescr"], if_index)] = name
        responses[_oid(OID_IF_TABLE["ifName"], if_index)] = name
        responses[_oid(OID_IF_TABLE["ifType"], if_index)] = if_type
        responses[_oid(OID_IF_TABLE["ifSpeed"], if_index)] = speed
        responses[_oid(OID_IF_TABLE["ifHighSpeed"], if_index)] = speed // 1_000_000
        admin = 1 if if_index != 103 else 1
        responses[_oid(OID_IF_TABLE["ifAdminStatus"], if_index)] = admin
        oper = 1
        if oper_down and if_index in oper_down:
            oper = 2
        if if_index == 102:  # port-channel admin up
            oper = 2
        responses[_oid(OID_IF_TABLE["ifOperStatus"], if_index)] = oper
        # counters
        base = if_index * 1_000_000
        responses[_oid(OID_IF_TABLE["ifHCInOctets"], if_index)] = base + 10_000_000
        responses[_oid(OID_IF_TABLE["ifHCOutOctets"], if_index)] = base + 5_000_000
        responses[_oid(OID_IF_TABLE["ifInOctets"], if_index)] = base + 10_000_000
        responses[_oid(OID_IF_TABLE["ifOutOctets"], if_index)] = base + 5_000_000
        responses[_oid(OID_IF_TABLE["ifInDiscards"], if_index)] = 0
        responses[_oid(OID_IF_TABLE["ifOutDiscards"], if_index)] = 0
        responses[_oid(OID_IF_TABLE["ifInErrors"], if_index)] = 0
        responses[_oid(OID_IF_TABLE["ifOutErrors"], if_index)] = 0

    if errors_rx:
        for if_index, value in errors_rx.items():
            responses[_oid(OID_IF_TABLE["ifInErrors"], if_index)] = value
    if errors_tx:
        for if_index, value in errors_tx.items():
            responses[_oid(OID_IF_TABLE["ifOutErrors"], if_index)] = value
    if discards_in:
        for if_index, value in discards_in.items():
            responses[_oid(OID_IF_TABLE["ifInDiscards"], if_index)] = value
    if discards_out:
        for if_index, value in discards_out.items():
            responses[_oid(OID_IF_TABLE["ifOutDiscards"], if_index)] = value

    # ENTITY-MIB (optional, fixtures 12/15) — flat OID entries for prefix-walk
    if include_entity_mib:
        responses["1.3.6.1.2.1.47.1.1.1.1.12.1"] = "Cisco Systems, Inc."
        responses["1.3.6.1.2.1.47.1.1.1.1.13.1"] = "C2960X-48TD"
        responses["1.3.6.1.2.1.47.1.1.1.1.14.1"] = "FOC1234AAAA"

    return responses


def _mk_creds(**overrides) -> SnmpCredentials:
    base = {
        "version": "3",
        "host": MGMT_IP,
        "username": "monitor",
        "auth_protocol": "SHA256",
        "auth_password": "auth-pw",
        "priv_protocol": "AES128",
        "priv_password": "priv-pw",
    }
    base.update(overrides)
    return SnmpCredentials(**base)


def _with_primary_neighbor(
    responses: dict[str, object],
    ip_address: str,
    mac_address: object,
    if_index: int = 2,
) -> dict[str, object]:
    suffix = f"{if_index}.1.4.{ip_address}"
    responses[f'{OID_IP_NET_TO_PHYSICAL["netAddress"]}.{suffix}'] = ip_address
    responses[f'{OID_IP_NET_TO_PHYSICAL["physAddress"]}.{suffix}'] = mac_address
    return responses


class CollectTelemetryTest(TestCase):
    def test_fixed_neighbor_table_yields_private_observed_host(self) -> None:
        responses = _with_primary_neighbor(
            _build_24_port_switch(), "192.168.10.25", "00:11:22:33:44:55"
        )
        calls: list[str] = []

        def lookup(ip_address: str, **_kwargs: object) -> dict[str, str]:
            calls.append(ip_address)
            return {"hostname": "WORKSTATION-25"}

        result = collect_telemetry(_mk_creds(), MockSnmpTransport(_mk_creds(), responses), netbios_lookup=lookup)
        self.assertEqual(result.observed_hosts_status, "available")
        self.assertEqual(calls, ["192.168.10.25"])
        self.assertEqual(result.observed_hosts[0].ip_address, "192.168.10.25")
        self.assertEqual(result.observed_hosts[0].mac_address, "00:11:22:33:44:55")
        self.assertEqual(result.observed_hosts[0].netbios_name, "WORKSTATION-25")

    def test_zero_mac_is_never_persisted_as_identity(self) -> None:
        responses = _with_primary_neighbor(
            _build_24_port_switch(), "192.168.10.26", "00:00:00:00:00:00"
        )
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda *_args, **_kwargs: None,
        )
        self.assertIsNone(result.observed_hosts[0].mac_address)

    def test_netbios_failure_keeps_snmp_observation_and_poll_success(self) -> None:
        responses = _with_primary_neighbor(
            _build_24_port_switch(), "192.168.10.27", "00-11-22-33-44-66"
        )
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda *_args, **_kwargs: None,
        )
        self.assertEqual(result.status, "connected")
        self.assertEqual(result.observed_hosts_status, "partial")
        self.assertEqual(result.observed_hosts[0].enrichment_status, "unavailable")

    def test_netbios_name_cannot_create_membership_without_snmp_neighbor(self) -> None:
        calls: list[str] = []
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), _build_24_port_switch()),
            netbios_lookup=lambda ip, **_kwargs: calls.append(ip) or {"hostname": "UNTRUSTED"},
        )
        self.assertEqual(result.observed_hosts_status, "empty")
        self.assertEqual(result.observed_hosts, [])
        self.assertEqual(calls, [])

    def test_legacy_neighbor_table_is_bounded_fallback(self) -> None:
        responses = _build_24_port_switch()
        suffix = "3.192.168.10.28"
        responses[f'{OID_IP_NET_TO_MEDIA["netAddress"]}.{suffix}'] = "192.168.10.28"
        responses[f'{OID_IP_NET_TO_MEDIA["physAddress"]}.{suffix}'] = "0011.2233.4477"
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(
                _mk_creds(), responses,
                fail_oids={OID_IP_NET_TO_PHYSICAL["physAddress"]},
            ),
            netbios_lookup=lambda *_args, **_kwargs: None,
        )
        self.assertEqual(result.observed_hosts[0].observation_source, "ip_net_to_media")
        self.assertEqual(result.observed_hosts[0].mac_address, "00:11:22:33:44:77")

    def test_unsupported_modern_and_legacy_neighbor_tables_are_conservative(self) -> None:
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, _build_24_port_switch(), fail_oids={
            OID_IP_NET_TO_PHYSICAL["physAddress"],
            OID_IP_NET_TO_MEDIA["netAddress"],
        })
        result = collect_telemetry(creds, mock, netbios_lookup=lambda *_args, **_kwargs: None)
        self.assertEqual(result.status, "connected")
        self.assertEqual(result.observed_hosts_status, "unsupported")
        self.assertEqual(result.observed_hosts, [])

    def test_duplicate_neighbor_rows_coalesce_by_ip_and_never_probe_public_ip(self) -> None:
        responses = _with_primary_neighbor(
            _build_24_port_switch(), "192.168.10.29", "00:00:00:00:00:00", 2
        )
        _with_primary_neighbor(responses, "192.168.10.29", "00:11:22:33:44:88", 3)
        _with_primary_neighbor(responses, "8.8.8.8", "00:11:22:33:44:99", 4)
        _with_primary_neighbor(responses, "192.0.2.44", "00:11:22:33:44:aa", 5)
        _with_primary_neighbor(responses, "192.168.10.255", "00:11:22:33:44:bb", 6)
        calls: list[str] = []
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda ip, **_kwargs: calls.append(ip) or None,
        )
        self.assertEqual(len(result.observed_hosts), 2)
        self.assertEqual(result.observed_hosts[0].mac_address, "00:11:22:33:44:88")
        self.assertEqual(calls, ["192.168.10.29"])

    def test_more_than_128_private_neighbors_survive_collection(self) -> None:
        responses = _build_24_port_switch()
        for host in range(1, 181):
            _with_primary_neighbor(
                responses,
                f"192.168.10.{host}",
                f"02:00:00:00:00:{host % 256:02x}",
                host,
            )

        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda *_args, **_kwargs: None,
        )

        self.assertEqual(len(result.observed_hosts), 180)
        self.assertEqual(result.observed_hosts[-1].ip_address, "192.168.10.180")

    def test_non_rfc1918_rows_do_not_consume_observed_host_capacity(self) -> None:
        responses = _build_24_port_switch()
        for host in range(1, 201):
            _with_primary_neighbor(
                responses,
                f"8.8.0.{host}",
                f"02:00:00:00:01:{host % 256:02x}",
                host,
            )
        for offset in range(256):
            third_octet, final_octet = divmod(offset, 254)
            _with_primary_neighbor(
                responses,
                f"10.0.{third_octet}.{final_octet + 1}",
                f"02:00:00:00:02:{offset % 256:02x}",
                201 + offset,
            )

        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda *_args, **_kwargs: None,
        )

        self.assertEqual(len(result.observed_hosts), 256)
        self.assertTrue(all(host.ip_address.startswith("10.0.") for host in result.observed_hosts))

    def test_observed_host_collection_remains_bounded(self) -> None:
        responses = _build_24_port_switch()
        for offset in range(600):
            third_octet, final_octet = divmod(offset, 254)
            _with_primary_neighbor(
                responses,
                f"172.16.{third_octet}.{final_octet + 1}",
                f"02:00:00:00:03:{offset % 256:02x}",
                offset + 1,
            )

        calls: list[str] = []
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda ip, **_kwargs: calls.append(ip) or None,
        )

        self.assertEqual(len(result.observed_hosts), 256)
        self.assertEqual(len(calls), 16)

    def test_netbios_enrichment_rotates_bounded_batches_and_wraps(self) -> None:
        responses = _build_24_port_switch()
        for host in range(1, 41):
            _with_primary_neighbor(
                responses,
                f"192.168.10.{host}",
                f"02:00:00:00:04:{host:02x}",
                host,
            )

        batches: list[list[str]] = []
        for offset in (0, 16, 32):
            calls: list[str] = []
            result = collect_telemetry(
                _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
                netbios_lookup=lambda ip, **_kwargs: calls.append(ip) or None,
                netbios_offset=offset,
            )
            batches.append(calls)
            self.assertEqual(result.status, "connected")
            self.assertEqual(len(calls), MAX_NETBIOS_ENRICHMENTS)

        self.assertEqual(batches[0], [f"192.168.10.{host}" for host in range(1, 17)])
        self.assertEqual(batches[1], [f"192.168.10.{host}" for host in range(17, 33)])
        self.assertEqual(
            batches[2],
            [f"192.168.10.{host}" for host in range(33, 41)] +
            [f"192.168.10.{host}" for host in range(1, 9)],
        )

    def test_netbios_rotation_handles_host_list_changes_without_arbitrary_queries(self) -> None:
        responses = _build_24_port_switch()
        expected = {f"10.20.0.{host}" for host in range(1, 19)}
        for host in range(1, 19):
            _with_primary_neighbor(
                responses,
                f"10.20.0.{host}",
                f"02:00:00:00:05:{host:02x}",
                host,
            )
        calls: list[str] = []
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda ip, **_kwargs: calls.append(ip) or None,
            netbios_offset=47,
        )

        self.assertEqual(len(calls), 16)
        self.assertTrue(set(calls).issubset(expected))
        self.assertEqual({host.ip_address for host in result.observed_hosts}, expected)

    def test_netbios_bounds_and_snmp_mac_authority_remain_unchanged(self) -> None:
        self.assertEqual(MAX_NETBIOS_ENRICHMENTS, 16)
        self.assertEqual(NETBIOS_ENRICHMENT_CONCURRENCY, 4)
        self.assertEqual(NETBIOS_ENRICHMENT_TIMEOUT_SECONDS, 0.5)
        responses = _with_primary_neighbor(
            _build_24_port_switch(), "192.168.10.31", "00:11:22:33:44:99"
        )
        timeouts: list[float] = []
        result = collect_telemetry(
            _mk_creds(), MockSnmpTransport(_mk_creds(), responses),
            netbios_lookup=lambda _ip, **kwargs: timeouts.append(kwargs["timeout_seconds"]) or {
                "hostname": "HOST-31",
                "mac_address": "de:ad:be:ef:00:01",
            },
        )

        self.assertEqual(timeouts, [0.5])
        self.assertEqual(result.observed_hosts[0].mac_address, "00:11:22:33:44:99")
        self.assertEqual(result.observed_hosts[0].netbios_name, "HOST-31")

    def test_24_port_switch_connected(self) -> None:
        """Fixture 1: 24-port switch returns connected with all interfaces."""
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch())
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "connected")
        self.assertEqual(result.sys_name, "core-switch-1")
        self.assertEqual(result.sys_up_time_ticks, 2000)
        self.assertEqual(result.manufacturer, "Cisco Systems, Inc.")
        self.assertEqual(result.model, "C2960X-48TD")
        self.assertEqual(len(result.interfaces), 28)  # 24 + vlan + loop + po + mgmt

    def test_physical_and_non_physical_separation(self) -> None:
        """Fixture 2: physical vs VLAN/Loopback/Port-channel classification."""
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch())
        result = collect_telemetry(creds, transport=mock)
        physical = [i for i in result.interfaces if i.is_physical]
        self.assertEqual(len(physical), 24)
        by_name = {i.name: i for i in result.interfaces}
        self.assertFalse(by_name["Vlan100"].is_physical)
        self.assertFalse(by_name["Loopback0"].is_physical)
        self.assertFalse(by_name["Port-channel1"].is_physical)
        self.assertFalse(by_name["mgmt0"].is_physical)

    def test_admin_up_oper_down(self) -> None:
        """Fixture 3: admin UP / oper DOWN captured distinctly."""
        creds = _mk_creds()
        mock = MockSnmpTransport(
            creds,
            responses=_build_24_port_switch(oper_down={7}),
        )
        result = collect_telemetry(creds, transport=mock)
        port7 = [i for i in result.interfaces if i.if_index == 7][0]
        self.assertEqual(port7.admin_status, "up")
        self.assertEqual(port7.oper_status, "down")

    def test_high_speed_fallback_for_speed(self) -> None:
        """Fixture 4: speed normalized to bps via ifHighSpeed when needed."""
        responses = _build_24_port_switch()
        # Strip ifSpeed from one port so ifHighSpeed fallback applies
        port = _oid(OID_IF_TABLE["ifSpeed"], 1)
        responses[port] = 0
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=responses)
        result = collect_telemetry(creds, transport=mock)
        port1 = [i for i in result.interfaces if i.if_index == 1][0]
        self.assertEqual(port1.speed_bps, 1_000_000_000)

    def test_missing_entity_mib_is_partial_not_fatal(self) -> None:
        """Fixture 12: missing ENTITY-MIB yields telemetry without hard identity."""
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch(include_entity_mib=False))
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "connected")
        # sysDescr fallback still infers manufacturer, but model/serial stay None
        self.assertEqual(result.manufacturer, "Cisco")
        self.assertIsNone(result.model)
        self.assertIsNone(result.serial_number)
        self.assertIsNotNone(result.sys_name)

    def test_unsupported_oid_returns_partial(self) -> None:
        """Fixture 15: an unsupported OID walk produces empty/partial, not fatal."""
        responses = _build_24_port_switch()
        # Remove ENTITY-MIB flat entries (unsupported)
        for key in list(responses):
            if key.startswith("1.3.6.1.2.1.47."):
                del responses[key]
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=responses)
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "connected")
        self.assertEqual(len(result.interfaces), 28)

    def test_snmpv3_auth_failure_propagates(self) -> None:
        """Fixture 13: SNMPv3 auth failure yields auth_failed status."""
        creds = _mk_creds()
        responses = _build_24_port_switch()
        for oid in OID_SYSTEM.values():
            responses[oid] = {"error": "authentication failure (incorrect password, community or key)", "category": "auth_failure"}
        mock = MockSnmpTransport(creds, responses=responses)
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "auth_failed")
        self.assertEqual(result.error_category, "auth_failure")

    def test_timeout_propagates(self) -> None:
        """Fixture 14: timeout yields timeout status."""
        creds = _mk_creds()
        responses = _build_24_port_switch()
        responses[OID_SYSTEM["sysDescr"]] = {"error": "SNMP request timed out", "category": "timeout"}
        mock = MockSnmpTransport(creds, responses=responses)
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "timeout")

    def test_failed_system_poll_still_serializes_empty_observation_state(self) -> None:
        creds = _mk_creds()
        responses = _build_24_port_switch()
        responses[OID_SYSTEM["sysDescr"]] = {"error": "SNMP request timed out", "category": "timeout"}
        poll = snmp_telemetry_poll(
            credentials=creds,
            target_id="00000000-0000-4000-8000-000000000001",
            runner_id="runner-1",
            node_id="00000000-0000-4000-8000-000000000002",
            ip_address=MGMT_IP,
            credential_profile_ref="core-switch-readonly",
            transport=MockSnmpTransport(creds, responses=responses),
        )
        payload = poll.to_payload()
        self.assertEqual(payload["device"]["observed_hosts_status"], "unsupported")
        self.assertEqual(payload["observed_hosts"], [])

    def test_errors_and_discards_collected(self) -> None:
        """Fixture 10/11: increasing errors and discards are captured."""
        creds = _mk_creds()
        responses = _build_24_port_switch(
            errors_rx={3: 8431},
            errors_tx={3: 120},
            discards_in={9: 45},
            discards_out={9: 12},
        )
        mock = MockSnmpTransport(creds, responses=responses)
        result = collect_telemetry(creds, transport=mock)
        port3 = [i for i in result.interfaces if i.if_index == 3][0]
        port9 = [i for i in result.interfaces if i.if_index == 9][0]
        self.assertEqual(port3.in_errors, 8431)
        self.assertEqual(port3.out_errors, 120)
        self.assertEqual(port9.in_discards, 45)
        self.assertEqual(port9.out_discards, 12)
        self.assertEqual(port3.in_errors_bits, 32)
        self.assertEqual(port9.in_discards_bits, 32)

    def test_high_capacity_octets_are_preferred_and_width_is_explicit(self) -> None:
        responses = _build_24_port_switch()
        responses[_oid(OID_IF_TABLE["ifInOctets"], 1)] = 123
        responses[_oid(OID_IF_TABLE["ifHCInOctets"], 1)] = 2**32 + 123
        result = collect_telemetry(_mk_creds(), transport=MockSnmpTransport(_mk_creds(), responses=responses))
        port1 = next(item for item in result.interfaces if item.if_index == 1)
        self.assertEqual(port1.in_octets, 2**32 + 123)
        self.assertEqual(port1.in_octets_bits, 64)
        self.assertEqual(port1.out_octets_bits, 64)

    def test_unavailable_high_capacity_octet_keeps_counter32_fallback(self) -> None:
        responses = _build_24_port_switch()
        responses[_oid(OID_IF_TABLE["ifInOctets"], 1)] = 456
        responses[_oid(OID_IF_TABLE["ifHCInOctets"], 1)] = None
        result = collect_telemetry(_mk_creds(), transport=MockSnmpTransport(_mk_creds(), responses=responses))
        port1 = next(item for item in result.interfaces if item.if_index == 1)
        self.assertEqual(port1.in_octets, 456)
        self.assertEqual(port1.in_octets_bits, 32)

    def test_missing_optional_interface_counter_marks_partial_without_losing_interface(self) -> None:
        responses = _build_24_port_switch()
        responses.pop(_oid(OID_IF_TABLE["ifInErrors"], 3))
        result = collect_telemetry(_mk_creds(), transport=MockSnmpTransport(_mk_creds(), responses=responses))
        port3 = next(item for item in result.interfaces if item.if_index == 3)
        self.assertEqual(result.status, "partial")
        self.assertIsNone(port3.in_errors)
        self.assertEqual(port3.name, "GigabitEthernet1/0/3")
        self.assertIsNotNone(port3.in_octets)

    def test_ifx_packet_oids_are_not_mislabeled_as_errors_or_discards(self) -> None:
        self.assertNotIn("ifHCInErrors", OID_IF_TABLE)
        self.assertNotIn("ifHCOutErrors", OID_IF_TABLE)
        self.assertNotIn("ifHCInDiscards", OID_IF_TABLE)
        self.assertNotIn("ifHCOutDiscards", OID_IF_TABLE)

    def test_snmpv2c_collection(self) -> None:
        """SNMPv2c read-only collection works with community auth."""
        creds = _mk_creds(version="2c", community="readonly")
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch())
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "connected")
        self.assertEqual(len(result.interfaces), 28)


class SnmpTelemetryPollTest(TestCase):
    def test_payload_preserves_normalized_error_categories(self) -> None:
        cases = {
            "auth_failure": "auth_failed",
            "timeout": "timeout",
            "unreachable": "unreachable",
            "unsupported": "unsupported",
            "agent_error": "poll_failed",
        }
        for category, expected in cases.items():
            with self.subTest(category=category):
                responses = _build_24_port_switch()
                responses[OID_SYSTEM["sysDescr"]] = {"error": "safe failure", "category": category}
                poll = snmp_telemetry_poll(
                    credentials=_mk_creds(),
                    target_id="00000000-0000-4000-8000-000000000001",
                    runner_id="runner-1",
                    node_id="00000000-0000-4000-8000-000000000002",
                    ip_address=MGMT_IP,
                    credential_profile_ref="core-switch-readonly",
                    transport=MockSnmpTransport(_mk_creds(), responses=responses),
                )
                self.assertEqual(poll.to_payload()["device"]["status"], expected)

    def test_payload_never_contains_secrets(self) -> None:
        """Fixture 17: credential redaction — payload has no secret material."""
        creds = _mk_creds(community="supersecret", version="2c")
        responses = _build_24_port_switch()
        mock = MockSnmpTransport(creds, responses=responses)
        poll = snmp_telemetry_poll(
            credentials=creds,
            target_id="00000000-0000-4000-8000-000000000001",
            runner_id="runner-1",
            node_id="00000000-0000-4000-8000-000000000002",
            ip_address=MGMT_IP,
            credential_profile_ref="core-switch-readonly",
            transport=mock,
        )
        payload = poll.to_payload()
        blob = str(payload)
        self.assertNotIn("supersecret", blob)
        self.assertNotIn("auth-pw", blob)
        self.assertNotIn("priv-pw", blob)
        self.assertIn("core-switch-readonly", blob)
        self.assertEqual(poll.status, "connected")
        self.assertEqual(len(poll.interfaces), 28)

    def test_uptime_ticks_to_seconds(self) -> None:
        creds = _mk_creds()
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch())
        poll = snmp_telemetry_poll(
            credentials=creds,
            target_id="00000000-0000-4000-8000-000000000001",
            runner_id="runner-1",
            node_id="00000000-0000-4000-8000-000000000002",
            ip_address=MGMT_IP,
            credential_profile_ref="core-switch-readonly",
            transport=mock,
        )
        self.assertEqual(poll.sys_up_time_seconds, 20)  # 2000 ticks / 100


class IsPhysicalInterfaceTest(TestCase):
    def test_ethernet_interface_is_physical(self) -> None:
        self.assertTrue(is_physical_interface("Gi1/0/1", "GigabitEthernet1/0/1", 6))

    def test_vlan_is_not_physical(self) -> None:
        self.assertFalse(is_physical_interface("Vlan100", "Vlan100", 6))

    def test_loopback_is_not_physical(self) -> None:
        self.assertFalse(is_physical_interface("Loopback0", "Loopback0", 24))

    def test_port_channel_is_not_physical(self) -> None:
        self.assertFalse(is_physical_interface("Port-channel1", "Port-channel1", 6))

    def test_tunnel_is_not_physical(self) -> None:
        self.assertFalse(is_physical_interface("Tunnel0", "Tunnel0", 114))

    def test_mgmt_is_not_physical(self) -> None:
        self.assertFalse(is_physical_interface("mgmt0", "mgmt0", 24))

    def test_no_reliable_signal_is_conservative(self) -> None:
        self.assertFalse(is_physical_interface(None, None, None))
