"""Deterministic mocked-SNMP tests for the managed telemetry collector.

No real SNMP device traffic is involved — the transport is always a
MockSnmpTransport fixture.
"""

from unittest import TestCase

from network_monitoring_agent.snmp_collector import (
    SnmpTelemetryPoll,
    collect_telemetry,
    is_physical_interface,
    snmp_telemetry_poll,
)
from network_monitoring_agent.snmp_transport import (
    OID_IF_TABLE,
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
        responses[_oid(OID_IF_TABLE["ifHCInErrors"], if_index)] = 0
        responses[_oid(OID_IF_TABLE["ifHCOutErrors"], if_index)] = 0

    if errors_rx:
        for if_index, value in errors_rx.items():
            responses[_oid(OID_IF_TABLE["ifInErrors"], if_index)] = value
            responses[_oid(OID_IF_TABLE["ifHCInErrors"], if_index)] = value
    if errors_tx:
        for if_index, value in errors_tx.items():
            responses[_oid(OID_IF_TABLE["ifOutErrors"], if_index)] = value
            responses[_oid(OID_IF_TABLE["ifHCOutErrors"], if_index)] = value
    if discards_in:
        for if_index, value in discards_in.items():
            responses[_oid(OID_IF_TABLE["ifInDiscards"], if_index)] = value
            responses[_oid(OID_IF_TABLE["ifHCInDiscards"], if_index)] = value
    if discards_out:
        for if_index, value in discards_out.items():
            responses[_oid(OID_IF_TABLE["ifOutDiscards"], if_index)] = value
            responses[_oid(OID_IF_TABLE["ifHCOutDiscards"], if_index)] = value

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


class CollectTelemetryTest(TestCase):
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

    def test_snmpv2c_collection(self) -> None:
        """SNMPv2c read-only collection works with community auth."""
        creds = _mk_creds(version="2c", community="readonly")
        mock = MockSnmpTransport(creds, responses=_build_24_port_switch())
        result = collect_telemetry(creds, transport=mock)
        self.assertEqual(result.status, "connected")
        self.assertEqual(len(result.interfaces), 28)


class SnmpTelemetryPollTest(TestCase):
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
