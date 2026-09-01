"""SNMP telemetry collector and normalization.

Protocol interaction is delegated to SnmpTransport (or MockSnmpTransport for tests).
This module assembles a fixed OID set, walks tables, normalizes values, and emits
JSON Lines events.

Never accepts arbitrary OIDs from the runner/backend — the OID set is fixed here.
"""

from __future__ import annotations

import ipaddress
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from .device_inspector import netbios_metadata
from .snmp_transport import (
    OID_ENTITY_MIB,
    OID_IF_TABLE,
    OID_IP_NET_TO_MEDIA,
    OID_IP_NET_TO_PHYSICAL,
    OID_SYSTEM,
    MockSnmpTransport,
    SnmpCredentials,
    SnmpResult,
    SnmpTransport,
    admin_status_name,
    is_physical_interface,
    oper_status_name,
)

LOGGER = logging.getLogger(__name__)

SYS_UPTIME_TICKS_PER_SECOND = 100  # sysUpTime is in hundredths of a second
MAX_OBSERVED_HOSTS = 256
MAX_RAW_NEIGHBOR_ROWS = 512
MAX_NETBIOS_ENRICHMENTS = 16
NETBIOS_ENRICHMENT_CONCURRENCY = 4
NETBIOS_ENRICHMENT_TIMEOUT_SECONDS = 0.5
RFC1918_NETWORKS = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))

IF_COLUMN_TO_FIELD: dict[str, str] = {
    "ifDescr": "description",
    "ifName": "name",
    "ifType": "if_type",
    "ifSpeed": "speed_bps",
    "ifAdminStatus": "admin_status_int",
    "ifOperStatus": "oper_status_int",
    "ifHCInOctets": "in_octets",
    "ifHCOutOctets": "out_octets",
    "ifInOctets": "in_octets",
    "ifOutOctets": "out_octets",
    "ifInDiscards": "in_discards",
    "ifOutDiscards": "out_discards",
    "ifInErrors": "in_errors",
    "ifOutErrors": "out_errors",
    "ifHighSpeed": "if_high_speed_mbps",
}

COUNTER_BITS_BY_COLUMN: dict[str, int] = {
    "ifHCInOctets": 64,
    "ifHCOutOctets": 64,
    "ifInOctets": 32,
    "ifOutOctets": 32,
    "ifInDiscards": 32,
    "ifOutDiscards": 32,
    "ifInErrors": 32,
    "ifOutErrors": 32,
}


@dataclass
class InterfaceSample:
    """One poll cycle of interface data from a single SNMP agent."""

    if_index: int
    name: str | None = None
    description: str | None = None
    if_type: int | None = None
    is_physical: bool = False
    admin_status: str | None = None
    oper_status: str | None = None
    speed_bps: int | None = None
    if_high_speed_mbps: int | None = None
    in_octets: int | None = None
    out_octets: int | None = None
    in_discards: int | None = None
    out_discards: int | None = None
    in_errors: int | None = None
    out_errors: int | None = None
    in_octets_bits: int | None = None
    out_octets_bits: int | None = None
    in_discards_bits: int | None = None
    out_discards_bits: int | None = None
    in_errors_bits: int | None = None
    out_errors_bits: int | None = None


@dataclass
class ObservedLanHost:
    """A host observed in a managed device neighbor table.

    This is Layer-3 neighbor evidence only. It does not assert a physical port
    attachment or inventory membership.
    """

    ip_address: str
    mac_address: str | None = None
    netbios_name: str | None = None
    observation_source: str = "ip_net_to_physical"
    enrichment_status: str = "not_attempted"


@dataclass
class SnmpTelemetryPoll:
    """Complete SNMP telemetry poll result for one target."""

    target_id: str
    runner_id: str
    node_id: str
    ip_address: str
    credential_profile_ref: str
    snmp_version: str
    result: SnmpResult
    interfaces: list[InterfaceSample] = field(default_factory=list)
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    sys_up_time_seconds: int | None = None
    error: str | None = None
    error_category: str | None = None
    observed_hosts: list[ObservedLanHost] = field(default_factory=list)
    observed_hosts_status: str = "unsupported"

    @property
    def status(self) -> str:
        return self.result.status

    def to_payload(self) -> dict[str, Any]:
        """Serialize for Edge Function delivery — secrets never included."""
        return {
            "type": "managed_telemetry",
            "target_id": self.target_id,
            "runner_id": self.runner_id,
            "node_id": self.node_id,
            "ip_address": self.ip_address,
            "credential_profile_ref": self.credential_profile_ref,
            "snmp_version": self.snmp_version,
            "device": {
                "status": self.status,
                "sys_name": self.result.sys_name,
                "sys_descr": self.result.sys_descr,
                "sys_object_id": self.result.sys_object_id,
                "uptime_seconds": self.sys_up_time_seconds,
                "manufacturer": self.manufacturer,
                "model": self.model,
                "serial_number": self.serial_number,
                "last_polled_at": _utc_now_iso(),
                "error": self.error,
                "error_category": self.error_category,
                "observed_hosts_status": self.observed_hosts_status,
            },
            "interfaces": [asdict(i) for i in self.interfaces],
            "observed_hosts": [asdict(host) for host in self.observed_hosts],
        }


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def collect_telemetry(
    credentials: SnmpCredentials,
    transport: SnmpTransport | MockSnmpTransport | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
    timeout_seconds: float = 3.0,
    netbios_lookup: Callable[..., dict[str, str] | None] = netbios_metadata,
    netbios_offset: int = 0,
) -> SnmpResult:
    """Collect SNMP telemetry from one device using a FIXED OID set.

    Never accepts arbitrary OIDs. All OIDs are defined in this module.
    """
    if transport is None:
        transport = SnmpTransport(credentials, timeout_seconds=timeout_seconds)

    result = SnmpResult()
    emit_event = emit or (lambda e: LOGGER.debug("snmp event: %s", e))

    emit_event({"type": "poll_start", "host": credentials.host, "version": credentials.version})

    # --- System group (scalars) ---
    if not _collect_system_group(transport, result):
        if result.error is None:
            result.error = "Failed to collect system group"
        result.error_category = result.error_category or "agent_error"
        emit_event({"type": "poll_error", "category": result.error_category, "message": result.error})
        return result

    # --- Interface table ---
    interfaces = _collect_interfaces(transport, result)
    result.interfaces = interfaces

    # --- Entity-MIB (optional) ---
    _collect_entity_mib(transport, result)

    # --- Neighbor evidence + optional naming enrichment ---
    # Membership comes only from fixed SNMP neighbor tables. NetBIOS is never
    # allowed to create a host observation by itself.
    result.observed_hosts, result.observed_hosts_status = _collect_observed_hosts(
        transport, netbios_lookup, netbios_offset
    )

    # Normalize manufacturer/model from sysDescr if Entity-MIB didn't provide
    if result.manufacturer is None or result.model is None:
        _infer_from_sys_descr(result)

    emit_event({"type": "poll_complete", "interface_count": len(result.interfaces), "status": result.status})
    return result


def _collect_observed_hosts(
    transport: SnmpTransport | MockSnmpTransport,
    netbios_lookup: Callable[..., dict[str, str] | None],
    netbios_offset: int = 0,
) -> tuple[list[ObservedLanHost], str]:
    # ipNetToPhysicalNetAddress is a not-accessible index object. Walk the
    # readable physical-address column and decode IPv4 from its OID index.
    primary_rows = transport.walk(
        OID_IP_NET_TO_PHYSICAL["physAddress"], max_rows=MAX_RAW_NEIGHBOR_ROWS
    )
    if _walk_unsupported(primary_rows):
        legacy_addresses = transport.walk(
            OID_IP_NET_TO_MEDIA["netAddress"], max_rows=MAX_RAW_NEIGHBOR_ROWS
        )
        if _walk_unsupported(legacy_addresses):
            return [], "unsupported"
        hosts = _normalize_neighbor_table(
            legacy_addresses,
            transport.walk(OID_IP_NET_TO_MEDIA["physAddress"], max_rows=MAX_RAW_NEIGHBOR_ROWS),
            OID_IP_NET_TO_MEDIA["netAddress"],
            "ip_net_to_media",
        )
    else:
        hosts = _normalize_neighbor_table(
            primary_rows,
            primary_rows,
            OID_IP_NET_TO_PHYSICAL["physAddress"],
            "ip_net_to_physical",
        )
    if not hosts:
        return [], "empty"

    attempted = _select_netbios_candidates(hosts, netbios_offset)
    with ThreadPoolExecutor(max_workers=NETBIOS_ENRICHMENT_CONCURRENCY) as pool:
        futures = {
            pool.submit(
                netbios_lookup,
                host.ip_address,
                timeout_seconds=NETBIOS_ENRICHMENT_TIMEOUT_SECONDS,
            ): host
            for host in attempted
        }
        for future in as_completed(futures):
            host = futures[future]
            try:
                metadata = future.result()
            except Exception:
                metadata = None
            hostname = metadata.get("hostname") if isinstance(metadata, dict) else None
            if isinstance(hostname, str) and hostname.strip():
                host.netbios_name = hostname.strip()[:15]
                host.enrichment_status = "resolved"
            else:
                host.enrichment_status = "unavailable"
    status = "available" if all(host.enrichment_status == "resolved" for host in hosts) else "partial"
    return hosts, status


def _select_netbios_candidates(
    hosts: list[ObservedLanHost],
    offset: int,
) -> list[ObservedLanHost]:
    """Select one bounded rotating batch from SNMP-observed hosts only."""
    eligible = [host for host in hosts if _netbios_unicast_candidate(host.ip_address)]
    if not eligible:
        return []
    safe_offset = offset if isinstance(offset, int) and not isinstance(offset, bool) and offset >= 0 else 0
    start = safe_offset % len(eligible)
    count = min(MAX_NETBIOS_ENRICHMENTS, len(eligible))
    return [eligible[(start + index) % len(eligible)] for index in range(count)]


def _netbios_unicast_candidate(ip_address: str) -> bool:
    """Avoid common IPv4 subnet/network broadcast endings for UDP enrichment."""
    final_octet = int(ip_address.rsplit(".", 1)[1])
    return final_octet not in (0, 255)


def _walk_unsupported(walked: Any) -> bool:
    if not isinstance(walked, dict) or "error" in walked:
        return True
    return bool(walked) and all(value is None for value in walked.values())


def _normalize_neighbor_table(
    addresses: dict[str, Any],
    physical_addresses: dict[str, Any],
    address_oid: str,
    source: str,
) -> list[ObservedLanHost]:
    mac_by_suffix: dict[str, str | None] = {}
    if isinstance(physical_addresses, dict) and "error" not in physical_addresses:
        for oid, value in physical_addresses.items():
            suffix = _oid_suffix(oid, OID_IP_NET_TO_PHYSICAL["physAddress"] if source == "ip_net_to_physical" else OID_IP_NET_TO_MEDIA["physAddress"])
            if suffix is not None:
                mac_by_suffix[suffix] = _normalize_mac(value)

    by_ip: dict[str, ObservedLanHost] = {}
    for oid, value in addresses.items():
        suffix = _oid_suffix(oid, address_oid)
        if suffix is None:
            continue
        ip = _normalize_neighbor_ip(value, suffix, source)
        if ip is None:
            continue
        mac = mac_by_suffix.get(suffix)
        current = by_ip.get(ip)
        if current is None:
            by_ip[ip] = ObservedLanHost(ip_address=ip, mac_address=mac, observation_source=source)
        elif current.mac_address is None and mac is not None:
            current.mac_address = mac
    sorted_private_ips = sorted(
        by_ip,
        key=lambda item: tuple(int(part) for part in item.split(".")),
    )
    return [by_ip[ip] for ip in sorted_private_ips[:MAX_OBSERVED_HOSTS]]


def _oid_suffix(oid: str, base: str) -> str | None:
    prefix = f"{base}."
    return oid[len(prefix):] if isinstance(oid, str) and oid.startswith(prefix) else None


def _normalize_neighbor_ip(value: Any, suffix: str, source: str) -> str | None:
    candidates: list[Any] = [value]
    parts = suffix.split(".")
    if source == "ip_net_to_physical" and len(parts) >= 7:
        try:
            if int(parts[-6]) == 1 and int(parts[-5]) == 4:
                candidates.append(".".join(parts[-4:]))
        except ValueError:
            pass
    elif source == "ip_net_to_media" and len(parts) >= 5:
        candidates.append(".".join(parts[-4:]))
    for candidate in candidates:
        try:
            text = str(candidate).strip()
            if text.lower().startswith("0x") and len(text) == 10:
                text = ".".join(str(byte) for byte in bytes.fromhex(text[2:]))
            address = ipaddress.ip_address(text)
            if (
                address.version == 4
                and any(address in network for network in RFC1918_NETWORKS)
                and not address.is_loopback
                and not address.is_link_local
                and not address.is_multicast
                and not address.is_unspecified
            ):
                return str(address)
        except (ValueError, TypeError):
            continue
    return None


def _normalize_mac(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        raw = value.hex()
    else:
        raw = str(value).strip().lower()
        if raw.startswith("0x"):
            raw = raw[2:]
        raw = "".join(char for char in raw if char in "0123456789abcdef")
    if len(raw) != 12 or raw == "000000000000":
        return None
    return ":".join(raw[index:index + 2] for index in range(0, 12, 2))


def _collect_system_group(
    transport: SnmpTransport | MockSnmpTransport,
    result: SnmpResult,
) -> bool:
    """Collect sysDescr, sysObjectID, sysUpTime, sysName scalars."""
    try:
        fields = [
            ("sys_descr", OID_SYSTEM["sysDescr"], _to_str),
            ("sys_object_id", OID_SYSTEM["sysObjectID"], _to_str),
            ("sys_up_time_ticks", OID_SYSTEM["sysUpTime"], _to_int),
            ("sys_name", OID_SYSTEM["sysName"], _to_str),
        ]
        for attr, oid, converter in fields:
            value = transport.get(oid)
            if isinstance(value, dict) and "error" in value:
                result.error = value.get("error", "SNMP request failed")
                result.error_category = value.get("category", "agent_error")
                return False
            setattr(result, attr, converter(value))
        return True
    except Exception as exc:
        LOGGER.warning("System group collection failed: %s", exc)
        result.error = str(exc)
        result.error_category = "agent_error"
        return False


def _collect_interfaces(
    transport: SnmpTransport | MockSnmpTransport,
    result: SnmpResult,
) -> list[InterfaceSample]:
    """Walk IF-MIB interface tables and build per-interface samples."""
    interface_data: dict[int, dict[str, Any]] = {}

    for col_name, oid in OID_IF_TABLE.items():
        if col_name == "base":
            continue
        walked = transport.walk(oid)
        if not isinstance(walked, dict) or "error" in walked:
            LOGGER.debug("IF-MIB walk for %s skipped", col_name)
            continue
        target_field = IF_COLUMN_TO_FIELD.get(col_name)
        if target_field is None:
            continue
        for oid_str, value in walked.items():
            if_index = _extract_if_index(oid_str)
            if if_index is None:
                continue
            if if_index not in interface_data:
                interface_data[if_index] = {"if_index": if_index}
            counter_bits = COUNTER_BITS_BY_COLUMN.get(col_name)
            if counter_bits is not None:
                if _to_int(value) is None:
                    continue
                bits_field = f"{target_field}_bits"
                existing_bits = interface_data[if_index].get(bits_field)
                if existing_bits is not None and existing_bits >= counter_bits:
                    continue
                interface_data[if_index][bits_field] = counter_bits
            interface_data[if_index][target_field] = value

    samples: list[InterfaceSample] = []
    for if_index in sorted(interface_data.keys()):
        raw = interface_data[if_index]
        samples.append(_build_interface_sample(raw))

    optional_fields = (
        "speed_bps", "in_octets", "out_octets", "in_discards",
        "out_discards", "in_errors", "out_errors",
    )
    result.partial_interface_telemetry = any(
        getattr(sample, field_name) is None
        for sample in samples
        for field_name in optional_fields
    )
    return samples


def _extract_if_index(oid_str: str) -> int | None:
    """Extract ifIndex from a full OID like 1.3.6.1.2.1.2.2.1.2.5 -> 5."""
    parts = oid_str.split(".")
    if len(parts) < 2:
        return None
    try:
        return int(parts[-1])
    except (ValueError, IndexError):
        return None


def _build_interface_sample(raw: dict[str, Any]) -> InterfaceSample:
    """Build an InterfaceSample from raw walked data."""
    if_index = raw.get("if_index", 0)
    name = _to_str(raw.get("name"))
    description = _to_str(raw.get("description")) or name
    if_type = _to_int(raw.get("if_type"))

    is_physical = is_physical_interface(name, description, if_type)

    speed_bps = _to_int(raw.get("speed_bps"))
    if_high_speed = _to_int(raw.get("if_high_speed_mbps"))
    if (speed_bps is None or speed_bps == 0) and if_high_speed is not None and if_high_speed > 0:
        speed_bps = if_high_speed * 1_000_000

    admin_int = _to_int(raw.get("admin_status_int"))
    oper_int = _to_int(raw.get("oper_status_int"))

    return InterfaceSample(
        if_index=if_index,
        name=name,
        description=description,
        if_type=if_type,
        is_physical=is_physical,
        admin_status=admin_status_name(admin_int),
        oper_status=oper_status_name(oper_int),
        speed_bps=speed_bps,
        if_high_speed_mbps=if_high_speed,
        in_octets=_to_int(raw.get("in_octets")),
        out_octets=_to_int(raw.get("out_octets")),
        in_discards=_to_int(raw.get("in_discards")),
        out_discards=_to_int(raw.get("out_discards")),
        in_errors=_to_int(raw.get("in_errors")),
        out_errors=_to_int(raw.get("out_errors")),
        in_octets_bits=_counter_bits(raw, "in_octets"),
        out_octets_bits=_counter_bits(raw, "out_octets"),
        in_discards_bits=_counter_bits(raw, "in_discards"),
        out_discards_bits=_counter_bits(raw, "out_discards"),
        in_errors_bits=_counter_bits(raw, "in_errors"),
        out_errors_bits=_counter_bits(raw, "out_errors"),
    )


def _counter_bits(raw: dict[str, Any], field_name: str) -> int | None:
    if _to_int(raw.get(field_name)) is None:
        return None
    bits = raw.get(f"{field_name}_bits")
    return bits if bits in (32, 64) else None


def _collect_entity_mib(
    transport: SnmpTransport | MockSnmpTransport,
    result: SnmpResult,
) -> None:
    """Optionally collect ENTITY-MIB for manufacturer/model/serial.

    Missing ENTITY-MIB produces partial telemetry, not fatal failure.
    """
    try:
        for oid_key, result_attr in [
            ("entPhysicalMfgName", "manufacturer"),
            ("entPhysicalModelName", "model"),
            ("entPhysicalSerialNum", "serial_number"),
        ]:
            walked = transport.walk(OID_ENTITY_MIB[oid_key])
            if isinstance(walked, dict) and "error" not in walked and not getattr(result, result_attr):
                for value in walked.values():
                    if value:
                        setattr(result, result_attr, _to_str(value))
                        break
    except Exception as exc:
        LOGGER.debug("ENTITY-MIB collection skipped: %s", exc)


def _infer_from_sys_descr(result: SnmpResult) -> None:
    """Best-effort manufacturer inference from sysDescr fallback."""
    if not result.sys_descr:
        return
    descr_lower = result.sys_descr.lower()
    for vendor, name in [
        ("cisco", "Cisco"),
        ("juniper", "Juniper"),
        ("huawei", "Huawei"),
        ("arista", "Arista"),
    ]:
        if vendor in descr_lower and not result.manufacturer:
            result.manufacturer = name


def _to_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict) and "error" in value:
        return None
    try:
        s = str(value).strip()
        return s or None
    except Exception:
        return None


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, dict) and "error" in value:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def snmp_telemetry_poll(
    credentials: SnmpCredentials,
    target_id: str,
    runner_id: str,
    node_id: str,
    ip_address: str,
    credential_profile_ref: str,
    transport: SnmpTransport | MockSnmpTransport | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
    timeout_seconds: float = 3.0,
    netbios_lookup: Callable[..., dict[str, str] | None] = netbios_metadata,
    netbios_offset: int = 0,
) -> SnmpTelemetryPoll:
    """High-level entry point: run a full telemetry poll and wrap in SnmpTelemetryPoll."""
    result = collect_telemetry(
        credentials, transport, emit, timeout_seconds, netbios_lookup, netbios_offset
    )
    return SnmpTelemetryPoll(
        target_id=target_id,
        runner_id=runner_id,
        node_id=node_id,
        ip_address=ip_address,
        credential_profile_ref=credential_profile_ref,
        snmp_version=credentials.version,
        result=result,
        interfaces=result.interfaces,
        manufacturer=result.manufacturer,
        model=result.model,
        serial_number=result.serial_number,
        sys_up_time_seconds=_ticks_to_seconds(result.sys_up_time_ticks),
        error=result.error,
        error_category=result.error_category,
        observed_hosts=result.observed_hosts,
        observed_hosts_status=result.observed_hosts_status,
    )


def _ticks_to_seconds(ticks: int | None) -> int | None:
    if ticks is None:
        return None
    return int(ticks // SYS_UPTIME_TICKS_PER_SECOND)
