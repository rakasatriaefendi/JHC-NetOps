"""SNMP telemetry collector and normalization.

Protocol interaction is delegated to SnmpTransport (or MockSnmpTransport for tests).
This module assembles a fixed OID set, walks tables, normalizes values, and emits
JSON Lines events.

Never accepts arbitrary OIDs from the runner/backend — the OID set is fixed here.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from .snmp_transport import (
    OID_ENTITY_MIB,
    OID_IF_TABLE,
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
    "ifHCInDiscards": "in_discards",
    "ifHCOutDiscards": "out_discards",
    "ifInDiscards": "in_discards",
    "ifOutDiscards": "out_discards",
    "ifHCInErrors": "in_errors",
    "ifHCOutErrors": "out_errors",
    "ifInErrors": "in_errors",
    "ifOutErrors": "out_errors",
    "ifHighSpeed": "if_high_speed_mbps",
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

    @property
    def status(self) -> str:
        if self.error:
            return self.error_category or "poll_failed"
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
            },
            "interfaces": [asdict(i) for i in self.interfaces],
        }


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def collect_telemetry(
    credentials: SnmpCredentials,
    transport: SnmpTransport | MockSnmpTransport | None = None,
    emit: Callable[[dict[str, object]], None] | None = None,
    timeout_seconds: float = 3.0,
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

    # Normalize manufacturer/model from sysDescr if Entity-MIB didn't provide
    if result.manufacturer is None or result.model is None:
        _infer_from_sys_descr(result)

    emit_event({"type": "poll_complete", "interface_count": len(result.interfaces), "status": result.status})
    return result


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
            interface_data[if_index][target_field] = value

    samples: list[InterfaceSample] = []
    for if_index in sorted(interface_data.keys()):
        raw = interface_data[if_index]
        samples.append(_build_interface_sample(raw))

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
    )


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
) -> SnmpTelemetryPoll:
    """High-level entry point: run a full telemetry poll and wrap in SnmpTelemetryPoll."""
    result = collect_telemetry(credentials, transport, emit, timeout_seconds)
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
    )


def _ticks_to_seconds(ticks: int | None) -> int | None:
    if ticks is None:
        return None
    return int(ticks // SYS_UPTIME_TICKS_PER_SECOND)
