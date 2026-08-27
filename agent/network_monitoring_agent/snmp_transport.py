"""SNMP protocol interaction layer with mockable transport.

All SNMP protocol interaction happens here — never in the runner.
Transport is injectable so tests can run without real devices.

Implemented against the actual installed PySNMP 7.x asyncio-based API.
The agent CLI keeps an asyncio event loop inside this module; the Windows
runner stays orchestration/scheduling only.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

LOGGER = logging.getLogger(__name__)

OID_SYSTEM = {
    "sysDescr": "1.3.6.1.2.1.1.1.0",
    "sysObjectID": "1.3.6.1.2.1.1.2.0",
    "sysUpTime": "1.3.6.1.2.1.1.3.0",
    "sysName": "1.3.6.1.2.1.1.5.0",
}

OID_IF_TABLE = {
    "ifDescr": "1.3.6.1.2.1.2.2.1.2",
    "ifType": "1.3.6.1.2.1.2.2.1.3",
    "ifSpeed": "1.3.6.1.2.1.2.2.1.5",
    "ifAdminStatus": "1.3.6.1.2.1.2.2.1.7",
    "ifOperStatus": "1.3.6.1.2.1.2.2.1.8",
    "ifInOctets": "1.3.6.1.2.1.2.2.1.10",
    "ifOutOctets": "1.3.6.1.2.1.2.2.1.16",
    "ifInDiscards": "1.3.6.1.2.1.2.2.1.13",
    "ifOutDiscards": "1.3.6.1.2.1.2.2.1.19",
    "ifInErrors": "1.3.6.1.2.1.2.2.1.14",
    "ifOutErrors": "1.3.6.1.2.1.2.2.1.20",
    "ifName": "1.3.6.1.2.1.31.1.1.1.1",
    "ifHighSpeed": "1.3.6.1.2.1.31.1.1.1.2",
    "ifHCInOctets": "1.3.6.1.2.1.31.1.1.1.6",
    "ifHCOutOctets": "1.3.6.1.2.1.31.1.1.1.10",
    "ifHCInDiscards": "1.3.6.1.2.1.31.1.1.1.7",
    "ifHCOutDiscards": "1.3.6.1.2.1.31.1.1.1.11",
    "ifHCInErrors": "1.3.6.1.2.1.31.1.1.1.5",
    "ifHCOutErrors": "1.3.6.1.2.1.31.1.1.1.9",
}

OID_ENTITY_MIB = {
    "entPhysicalMfgName": "1.3.6.1.2.1.47.1.1.1.1.12",
    "entPhysicalModelName": "1.3.6.1.2.1.47.1.1.1.1.13",
    "entPhysicalSerialNum": "1.3.6.1.2.1.47.1.1.1.1.14",
}

SNMP_ERROR_CATEGORIES = {
    "timed out": "timeout",
    "timeout": "timeout",
    "no response": "timeout",
    "auth": "auth_failure",
    "security": "auth_failure",
    "unknown": "auth_failure",
    "usm": "auth_failure",
    "wrong": "auth_failure",
    "unsupported": "unsupported",
    "unreachable": "unreachable",
    "no route": "unreachable",
    "refused": "unreachable",
}

NON_PHYSICAL_IF_TYPES = {
    1, 13, 16, 47, 48, 53, 54, 66, 77, 78, 114, 131, 134, 136, 137, 138, 140, 141, 148, 246, 247,
}

NON_PHYSICAL_NAME_PATTERNS = (
    "vlan", "loopback", "port-channel", "portchannel", "tunnel", "gre", "gretap",
    "sit", "ipip", "vti", "dummy", "bond", "bridge", "br-", "docker", "veth",
    "flannel", "cni", "calico", "cilium", "tun", "tap", "vrrp", "hsrp", "glbp",
    "ospf", "bgp", "eigrp", "nve", "nvme", "usb", "cpu", "switch", "virtual",
    "mgmt", "management", "stack", "irb", "ve", "svi", "reth",
)

ETHERNET_IF_TYPES = {6, 117, 152, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220}

ADMIN_STATUS_NAMES = {0: "down", 1: "up", 2: "testing"}
OPER_STATUS_NAMES = {1: "up", 2: "down", 3: "testing", 4: "unknown"}


@dataclass(frozen=True)
class SnmpCredentials:
    """SNMP credentials resolved locally on the runner.

    Never logged with secret fields.
    """

    version: str
    host: str
    port: int = 161
    username: str | None = None
    auth_protocol: str | None = None
    auth_password: str | None = None
    priv_protocol: str | None = None
    priv_password: str | None = None
    community: str | None = None

    def __post_init__(self) -> None:
        if self.version == "2c" and not self.community:
            raise ValueError("SNMPv2c requires community string")
        if self.version == "3" and not self.username:
            raise ValueError("SNMPv3 requires username")
        if self.version not in ("3", "2c"):
            raise ValueError("SNMP version must be '3' or '2c'")

    def redacted_summary(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "auth_protocol": self.auth_protocol,
            "priv_protocol": self.priv_protocol,
            "community": "***" if self.community else None,
            "auth_password": "***redacted***" if self.auth_password else None,
            "priv_password": "***redacted***" if self.priv_password else None,
        }


@dataclass
class SnmpResult:
    """Normalized SNMP poll result from one polling cycle."""

    sys_descr: str | None = None
    sys_object_id: str | None = None
    sys_up_time_ticks: int | None = None
    sys_name: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    interfaces: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    error_category: str | None = None

    @property
    def status(self) -> str:
        if self.error:
            category = self.error_category or "poll_failed"
            return {
                "auth_failure": "auth_failed",
                "timeout": "timeout",
                "unreachable": "unreachable",
                "unsupported": "unsupported",
            }.get(category, "poll_failed")
        if not self.interfaces:
            return "partial"
        return "connected"

    @property
    def is_complete(self) -> bool:
        return self.error is None and len(self.interfaces) > 0

    @property
    def is_partial(self) -> bool:
        return self.error is None and len(self.interfaces) == 0


def _value_to_python(value: Any) -> Any:
    """Convert a PySNMP varbind value into a plain Python value."""
    from pysnmp.proto import rfc1905
    from pysnmp.hlapi.v1arch.asyncio import OctetString

    if isinstance(value, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance)):
        return None
    if isinstance(value, rfc1905.EndOfMibView):
        return None
    if isinstance(value, OctetString):
        try:
            text = value.asOctets().decode("utf-8", errors="replace").strip()
            return text
        except Exception:
            return value.prettyPrint()
    try:
        return int(value)
    except (ValueError, TypeError):
        try:
            return value.prettyPrint()
        except Exception:
            return str(value)


def classify_error(message: str) -> str:
    msg_lower = (message or "").lower()
    for needle, category in SNMP_ERROR_CATEGORIES.items():
        if needle in msg_lower:
            return category
    return "agent_error"


class SnmpTransport:
    """Real SNMP transport using the installed PySNMP 7.x asyncio API.

    Synchronous get()/walk() wrappers run a private asyncio event loop.
    """

    def __init__(
        self,
        credentials: SnmpCredentials,
        timeout_seconds: float = 3.0,
        retries: int = 1,
    ) -> None:
        self.creds = credentials
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self._loop: asyncio.AbstractEventLoop | None = None
        self._engine: Any = None

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
        return self._loop

    def get(self, oid: str) -> Any:
        loop = self._ensure_loop()
        return loop.run_until_complete(self._get(oid))

    def walk(self, oid: str) -> dict[str, Any]:
        loop = self._ensure_loop()
        return loop.run_until_complete(self._walk(oid))

    def close(self) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.close()
        self._loop = None

    # --- async internals ---

    async def _get(self, oid: str) -> Any:
        try:
            engine, auth_data, context = await self._build_args()
            target = await self._build_target()
            if self.creds.version == "3":
                from pysnmp.hlapi.v3arch.asyncio import ObjectType, ObjectIdentity
                from pysnmp.hlapi.v3arch.asyncio import get_cmd
                error_indication, error_status, error_index, var_binds = await get_cmd(
                    engine, auth_data, target, context,
                    ObjectType(ObjectIdentity(oid)), lookupMib=False,
                )
            else:
                from pysnmp.hlapi.v1arch.asyncio import ObjectType, ObjectIdentity
                from pysnmp.hlapi.v1arch.asyncio import get_cmd
                error_indication, error_status, error_index, var_binds = await get_cmd(
                    engine, auth_data, target,
                    ObjectType(ObjectIdentity(oid)), lookupMib=False,
                )

            if error_indication:
                return {"error": str(error_indication), "category": classify_error(str(error_indication))}
            if error_status:
                return {"error": f"SNMP error: {error_status}", "category": "agent_error"}
            if var_binds:
                name, value = var_binds[0]
                return _value_to_python(value)
            return None
        except Exception as exc:
            LOGGER.warning("SNMP get failed for %s: %s", oid, exc.__class__.__name__)
            return {"error": str(exc), "category": classify_error(str(exc))}

    async def _walk(self, oid: str) -> dict[str, Any]:
        try:
            engine, auth_data, context = await self._build_args()
            target = await self._build_target()
            results: dict[str, Any] = {}
            if self.creds.version == "3":
                from pysnmp.hlapi.v3arch.asyncio import ObjectType, ObjectIdentity
                from pysnmp.hlapi.v3arch.asyncio import walk_cmd
                iterator = walk_cmd(
                    engine, auth_data, target, context,
                    ObjectType(ObjectIdentity(oid)), lookupMib=False, lexicographicMode=False,
                )
            else:
                from pysnmp.hlapi.v1arch.asyncio import ObjectType, ObjectIdentity
                from pysnmp.hlapi.v1arch.asyncio import walk_cmd
                iterator = walk_cmd(
                    engine, auth_data, target,
                    ObjectType(ObjectIdentity(oid)), lookupMib=False, lexicographicMode=False,
                )

            from pysnmp.proto import rfc1905

            async for error_indication, error_status, error_index, var_binds in iterator:
                if error_indication:
                    return {"error": str(error_indication), "category": classify_error(str(error_indication))}
                if error_status:
                    return {"error": f"SNMP error: {error_status}", "category": "agent_error"}
                for var_bind in var_binds:
                    name, value = var_bind
                    oid_str = name.prettyPrint()
                    if isinstance(value, rfc1905.EndOfMibView):
                        return results
                    results[oid_str] = _value_to_python(value)
            return results
        except Exception as exc:
            LOGGER.warning("SNMP walk failed for %s: %s", oid, exc.__class__.__name__)
            return {"error": str(exc), "category": classify_error(str(exc))}

    async def _build_target(self) -> Any:
        if self.creds.version == "3":
            from pysnmp.hlapi.v3arch.asyncio import UdpTransportTarget
        else:
            from pysnmp.hlapi.v1arch.asyncio import UdpTransportTarget
        return await UdpTransportTarget.create(
            (self.creds.host, self.creds.port),
            timeout=self.timeout_seconds,
            retries=self.retries,
        )

    async def _build_args(self) -> tuple[Any, Any, Any]:
        if self.creds.version == "3":
            from pysnmp.hlapi.v3arch.asyncio import SnmpEngine, ContextData
            from pysnmp.hlapi.v3arch.asyncio.auth import UsmUserData
            from pysnmp.hlapi.v3arch.asyncio.auth import (
                usmHMAC192SHA256AuthProtocol,
                usmHMACSHAAuthProtocol,
                usmHMACMD5AuthProtocol,
                usmAesCfb128Protocol,
                usmAesCfb256Protocol,
                usmDESPrivProtocol,
                usmNoAuthProtocol,
                usmNoPrivProtocol,
            )
            engine = self._get_engine(SnmpEngine)
            auth_data = UsmUserData(
                self.creds.username,
                authKey=self.creds.auth_password,
                privKey=self.creds.priv_password,
                authProtocol=self._auth_proto(usmHMAC192SHA256AuthProtocol, usmHMACSHAAuthProtocol, usmHMACMD5AuthProtocol, usmNoAuthProtocol),
                privProtocol=self._priv_proto(usmAesCfb128Protocol, usmAesCfb256Protocol, usmDESPrivProtocol, usmNoPrivProtocol),
            )
            return engine, auth_data, ContextData()
        else:
            from pysnmp.hlapi.v1arch.asyncio import SnmpDispatcher
            from pysnmp.hlapi.v1arch.asyncio.auth import CommunityData
            engine = self._get_engine(SnmpDispatcher)
            auth_data = CommunityData(self.creds.community or "", mpModel=1)
            return engine, auth_data, None

    def _get_engine(self, engine_cls: type) -> Any:
        if self._engine is None:
            self._engine = engine_cls()
        return self._engine

    def _auth_proto(self, sha256, sha1, md5, none) -> Any:
        proto = self.creds.auth_protocol or "SHA256"
        if proto in ("SHA256",):
            return sha256
        if proto in ("SHA", "SHA1"):
            return sha1
        if proto == "MD5":
            return md5
        return none

    def _priv_proto(self, aes128, aes256, des, none) -> Any:
        proto = self.creds.priv_protocol or "AES128"
        if proto in ("AES128", "AES"):
            return aes128
        if proto == "AES256":
            return aes256
        if proto == "DES":
            return des
        return none


class MockSnmpTransport:
    """Injectable mock transport for deterministic testing.

    Contract mirrors SnmpTransport: get() returns a scalar or an error dict;
    walk() returns {oid_string: value} or an error dict.
    """

    def __init__(
        self,
        credentials: SnmpCredentials | None = None,
        responses: dict[str, Any] | None = None,
        fail_oids: set[str] | None = None,
    ) -> None:
        self.creds = credentials or SnmpCredentials(version="3", host="127.0.0.1", username="test")
        self.responses = responses or {}
        self.fail_oids = fail_oids or set()
        self.polled_oids: list[str] = []

    def get(self, oid: str) -> Any:
        self.polled_oids.append(oid)
        if oid in self.fail_oids:
            return {"error": "noSuchObject", "category": "agent_error"}
        if oid in self.responses:
            return self.responses[oid]
        return {"error": "noSuchObject", "category": "agent_error"}

    def walk(self, oid: str) -> dict[str, Any]:
        self.polled_oids.append(oid)
        if oid in self.fail_oids:
            return {"error": "noSuchObject", "category": "agent_error"}
        prefix = f"{oid}."
        return {
            key: value
            for key, value in self.responses.items()
            if isinstance(key, str) and key.startswith(prefix)
        }

    def close(self) -> None:
        pass


def is_physical_interface(
    name: str | None,
    description: str | None,
    if_type: int | None,
    ent_physical_class: str | None = None,
) -> bool:
    """Conservative physical-port classifier.

    Never claims a port is physical purely because ifType reports ethernet(6).
    Uses naming patterns, ifType, and optional ENTITY-MIB classification.
    """
    combined = f"{(name or '').lower().strip()} {(description or '').lower().strip()}"

    for pattern in NON_PHYSICAL_NAME_PATTERNS:
        if pattern in combined:
            return False

    if if_type is not None and if_type in NON_PHYSICAL_IF_TYPES:
        return False

    if ent_physical_class:
        if ent_physical_class.lower() not in ("port", "module", "container", "chassis", "backplane"):
            return False
        if ent_physical_class.lower() == "port":
            if any(v in combined for v in ("virtual", "vlan", "loop", "tunnel")):
                return False
            return True

    if if_type is not None and if_type in ETHERNET_IF_TYPES:
        if any(v in combined for v in ("virtual", "vlan", "loop", "tunnel")):
            return False
        return True

    if if_type is not None and if_type >= 200:
        return False

    return False


def admin_status_name(value: int | None) -> str | None:
    if value is None:
        return None
    return ADMIN_STATUS_NAMES.get(value, "testing")


def oper_status_name(value: int | None) -> str | None:
    if value is None:
        return None
    return OPER_STATUS_NAMES.get(value, "unknown")
