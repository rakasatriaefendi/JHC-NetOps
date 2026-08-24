"""Bounded, single-target Device Inspector with normalized metadata only."""

from __future__ import annotations

import concurrent.futures
import errno
import html
import importlib.metadata
import ipaddress
import multiprocessing
import os
import platform
import re
import signal
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from .inspection_trace import InspectionTrace

TCP_PORTS = (22, 80, 443, 445, 554, 631, 1883, 8080, 8443, 9100)
HTTP_PORTS = (80, 8080)
HTTPS_PORTS = (443, 8443)
TCP_TIMEOUT_SECONDS = 1.0
METADATA_TIMEOUT_SECONDS = 2.5
MAX_CONCURRENCY = 4
MAX_HTTP_BYTES = 16 * 1024
MAX_UPNP_BYTES = 32 * 1024
MAX_TLS_OUTPUT_BYTES = 16 * 1024
MAX_NETBIOS_BYTES = 2048
INSPECTION_BUDGET_SECONDS = 18.0
PROCESS_EXIT_GRACE_SECONDS = 2.0
COLLECTOR_TERMINATION_GRACE_SECONDS = 0.25
COLLECTOR_START_GRACE_SECONDS = 0.05
TCP_COLLECTION_TIMEOUT_SECONDS = 4.0
MIN_OPTIONAL_BUDGET_SECONDS = 0.05

SERVICE_NAMES = {
    22: "SSH", 80: "HTTP", 443: "HTTPS", 445: "SMB",
    554: "RTSP", 631: "IPP", 1883: "MQTT", 8080: "HTTP Alternate",
    8443: "HTTPS Alternate", 9100: "Printer",
}


class InspectionDeadlineExceeded(TimeoutError):
    """The agent-wide Device Inspector budget was exhausted safely."""


class _InspectionDeadline:
    def __init__(self, budget_seconds: float, monotonic: Callable[[], float]) -> None:
        if budget_seconds <= 0:
            raise ValueError("Inspection budget must be positive")
        self._monotonic = monotonic
        self._expires_at = monotonic() + budget_seconds

    def remaining(self) -> float:
        return max(0.0, self._expires_at - self._monotonic())

    def timeout(self, maximum: float) -> float:
        remaining = self.remaining()
        if remaining <= 0:
            raise InspectionDeadlineExceeded("Device inspection deadline reached")
        return max(0.001, min(maximum, remaining))

    def has_time(self, minimum: float = MIN_OPTIONAL_BUDGET_SECONDS) -> bool:
        return self.remaining() > minimum


def inspector_capabilities() -> dict[str, Any]:
    """Return a compact, non-secret capability snapshot for runner preflight."""
    try:
        scapy_version = importlib.metadata.version("scapy")
        scapy_available = True
    except importlib.metadata.PackageNotFoundError:
        scapy_version = None
        scapy_available = False

    optional_tools = {
        "openssl": bool(shutil.which("openssl")),
        "scapy_oui": scapy_available,
    }
    return {
        "schema_version": 1,
        "available": True,
        "probe_engine": "python_socket",
        "python_version": platform.python_version(),
        "required": {"python_socket": True},
        "collectors": {
            "tcp_connect": True,
            "http_metadata": True,
            "tls_metadata": optional_tools["openssl"],
            "upnp_unicast": True,
            "netbios_node_status": True,
        },
        "optional": optional_tools,
        "optional_versions": {
            "scapy": scapy_version,
        },
        "available_but_unused": {
            "nmap": bool(shutil.which("nmap")),
            "curl": bool(shutil.which("curl")),
        },
        "optional_not_required": {
            "arp_scan": bool(shutil.which("arp-scan")),
            "nbtscan": bool(shutil.which("nbtscan")),
            "mdns": bool(shutil.which("avahi-browse")),
        },
    }


def inspect_device(
    target: str,
    context: dict[str, Any],
    emit: Callable[[dict[str, Any]], None] | None = None,
    *,
    total_budget_seconds: float = INSPECTION_BUDGET_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
    trace: InspectionTrace | None = None,
) -> dict[str, Any]:
    """Inspect one private IPv4 using a fixed low-impact probe plan."""
    if trace:
        trace.emit("inspect_device_entry")
    ip = str(ipaddress.ip_address(target))
    if not ipaddress.ip_address(ip).is_private:
        raise ValueError("Device Inspector target must be a private IPv4 address")
    notify = emit or (lambda _event: None)
    process_exit_grace = min(PROCESS_EXIT_GRACE_SECONDS, total_budget_seconds * 0.2)
    collector_budget = max(0.001, total_budget_seconds - process_exit_grace)
    deadline = _InspectionDeadline(collector_budget, monotonic)
    notify({"type": "stage", "stage": "network_role"})
    normalized_context = _normalize_context(ip, context)

    notify({"type": "stage", "stage": "identity"})
    mac = normalized_context["mac"]
    mac_kind = "unavailable"
    mac_vendor = None
    if mac:
        mac_kind = "locally_administered" if is_locally_administered(mac) else "global"
        if mac_kind == "global":
            mac_vendor = lookup_mac_vendor(mac)

    notify({"type": "stage", "stage": "services"})
    tcp_timeout = min(
        TCP_COLLECTION_TIMEOUT_SECONDS,
        max(0.0, deadline.remaining() - COLLECTOR_TERMINATION_GRACE_SECONDS - COLLECTOR_START_GRACE_SECONDS),
    )
    tcp_phase_started = time.monotonic()
    if trace:
        trace.emit("tcp_phase_start", remaining_budget_ms=deadline.remaining() * 1000)
    tcp_results, tcp_collector_statuses = _run_isolated_collectors(
        [("tcp", None, lambda: probe_tcp_service_states(
            ip, _InspectionDeadline(max(0.001, tcp_timeout), time.monotonic),
        ), tcp_timeout)],
        deadline,
        trace,
    ) if tcp_timeout > 0 else ({}, {"tcp": "skipped_budget"})
    tcp_status = tcp_collector_statuses.get("tcp", "failed")
    if trace:
        trace.emit(
            "tcp_phase_end",
            status=tcp_status,
            duration_ms=(time.monotonic() - tcp_phase_started) * 1000,
        )
    tcp_states = tcp_results.get(("tcp", None))
    if not isinstance(tcp_states, list):
        tcp_states = []
    open_ports = [item["port"] for item in tcp_states if item["state"] == "open"]
    http: list[dict[str, Any]] = []
    tls: list[dict[str, Any]] = []
    upnp: dict[str, Any] | None = None
    netbios: dict[str, str] | None = None
    tasks: list[tuple[str, int | None, Callable[[], Any]]] = []
    for port in (*HTTP_PORTS, *HTTPS_PORTS):
        if port in open_ports:
            tasks.append(("http", port, lambda port=port: http_metadata(ip, port, use_tls=port in HTTPS_PORTS, deadline=deadline)))
    for port in HTTPS_PORTS:
        if port in open_ports:
            tasks.append(("tls", port, lambda port=port: tls_metadata(ip, port, deadline=deadline)))
    tasks.append(("upnp", None, lambda: upnp_metadata(ip, deadline=deadline)))
    if 445 in open_ports:
        tasks.append(("netbios", None, lambda: netbios_metadata(ip, deadline=deadline)))
    isolated_tasks = [
        (kind, port, task, min(
            METADATA_TIMEOUT_SECONDS,
            max(0.0, deadline.remaining() - COLLECTOR_TERMINATION_GRACE_SECONDS - COLLECTOR_START_GRACE_SECONDS),
        ))
        for kind, port, task in tasks
    ]
    metadata_results, metadata_collector_statuses = _run_isolated_collectors(isolated_tasks, deadline, trace)
    for (kind, _port), metadata in metadata_results.items():
        if kind == "http" and metadata:
            http.append(metadata)
        elif kind == "tls" and metadata:
            tls.append(metadata)
        elif kind == "upnp":
            upnp = metadata
        elif kind == "netbios":
            netbios = metadata
    http.sort(key=lambda item: int(item.get("port", 0)))
    tls.sort(key=lambda item: int(item.get("port", 0)))
    collector_statuses = {**tcp_collector_statuses, **metadata_collector_statuses}
    collector_incomplete = any(status != "completed" for status in collector_statuses.values())
    deadline_reached = deadline.remaining() <= 0
    partial = collector_incomplete or deadline_reached

    partial_started = time.monotonic()
    if trace:
        trace.emit("partial_finalize_start", remaining_budget_ms=deadline.remaining() * 1000)
    evidence_input = {
        "ip": ip,
        "reachable": bool(normalized_context["reachable"] or open_ports),
        "route_role": normalized_context["route_role"],
        "same_subnet": normalized_context["same_subnet"],
        "is_this_device": normalized_context["is_this_device"],
        "interface_index": normalized_context["interface_index"],
        "interface_alias": normalized_context["interface_alias"],
        "interface_description": normalized_context["interface_description"],
        "interface_type": normalized_context["interface_type"],
        "mac": mac,
        "mac_kind": mac_kind,
        "mac_vendor": mac_vendor,
        "open_ports": open_ports,
        "tcp_states": tcp_states,
        "http": http,
        "tls": tls,
        "upnp": upnp,
        "netbios": netbios,
        "collector_statuses": collector_statuses,
        "partial": partial,
        "deadline_reached": deadline_reached,
    }
    if deadline_reached and not _has_usable_evidence(evidence_input):
        if trace:
            trace.emit(
                "partial_finalize_end",
                status="failed",
                duration_ms=(time.monotonic() - partial_started) * 1000,
            )
        raise InspectionDeadlineExceeded("Device inspection deadline reached before usable evidence")
    if trace:
        trace.emit(
            "partial_finalize_end",
            status="completed",
            duration_ms=(time.monotonic() - partial_started) * 1000,
        )
    notify({"type": "stage", "stage": "normalizing"})
    normalization_started = time.monotonic()
    if trace:
        trace.emit("normalization_start")
    result = classify_device(evidence_input)
    if trace:
        trace.emit(
            "normalization_end",
            status="completed",
            duration_ms=(time.monotonic() - normalization_started) * 1000,
        )
    return result


def _run_isolated_collectors(
    tasks: list[tuple[str, int | None, Callable[[], Any], float]],
    deadline: _InspectionDeadline,
    trace: InspectionTrace | None = None,
) -> tuple[dict[tuple[str, int | None], Any], dict[str, str]]:
    """Run bounded collectors in killable process groups, never parent threads."""
    if not tasks:
        return {}, {}
    if "fork" not in multiprocessing.get_all_start_methods():
        raise RuntimeError("Device Inspector requires a POSIX fork process context")
    context = multiprocessing.get_context("fork")
    pending = list(tasks)
    active: list[dict[str, Any]] = []
    results: dict[tuple[str, int | None], Any] = {}
    statuses: dict[str, str] = {}

    try:
        while pending or active:
            while pending and len(active) < MAX_CONCURRENCY:
                kind, port, collector, maximum = pending[0]
                remaining = deadline.remaining()
                required = max(0.001, maximum) + COLLECTOR_TERMINATION_GRACE_SECONDS
                if remaining < required:
                    for skipped_kind, skipped_port, _skipped_collector, _skipped_maximum in pending:
                        name = _collector_name(skipped_kind, skipped_port)
                        statuses[name] = "skipped_budget"
                        if trace:
                            trace.emit("collector_start", collector_name=name, remaining_budget_ms=remaining * 1000)
                            trace.emit("collector_end", collector_name=name, status="skipped_budget", duration_ms=0)
                    pending.clear()
                    break
                pending.pop(0)
                collector_name = _collector_name(kind, port)
                started_at = time.monotonic()
                if trace:
                    trace.emit("collector_start", collector_name=collector_name, remaining_budget_ms=remaining * 1000)
                receiver, sender = context.Pipe(duplex=False)
                process = context.Process(
                    target=_isolated_collector_entry,
                    args=(sender, collector),
                    daemon=False,
                )
                process.start()
                sender.close()
                if trace:
                    process_group_id = _safe_process_group_id(process.pid)
                    trace.emit(
                        "child_created",
                        collector_name=collector_name,
                        child_pid=process.pid,
                        process_group_id=process_group_id,
                    )
                active.append({
                    "key": (kind, port),
                    "collector_name": collector_name,
                    "process": process,
                    "receiver": receiver,
                    "expires_at": time.monotonic() + max(0.001, maximum),
                    "started_at": started_at,
                })

            if not active:
                break
            for state in list(active):
                process = state["process"]
                receiver = state["receiver"]
                if receiver.poll():
                    try:
                        status, value = receiver.recv()
                    except (EOFError, OSError):
                        status, value = "error", None
                    if status == "ok":
                        results[state["key"]] = value
                    normalized_status = "completed" if status == "ok" else "failed"
                    statuses[state["collector_name"]] = normalized_status
                    if trace:
                        trace.emit(
                            "collector_end",
                            collector_name=state["collector_name"],
                            status=normalized_status,
                            duration_ms=(time.monotonic() - state["started_at"]) * 1000,
                        )
                    _stop_isolated_process(process, trace, state["collector_name"])
                    receiver.close()
                    active.remove(state)
                elif not process.is_alive():
                    process.join(timeout=COLLECTOR_TERMINATION_GRACE_SECONDS)
                    statuses[state["collector_name"]] = "failed"
                    if trace:
                        trace.emit(
                            "collector_end",
                            collector_name=state["collector_name"],
                            status="failed",
                            duration_ms=(time.monotonic() - state["started_at"]) * 1000,
                        )
                        _trace_child_exit(process, trace, state["collector_name"])
                    receiver.close()
                    active.remove(state)
                elif time.monotonic() >= state["expires_at"] or deadline.remaining() <= 0:
                    statuses[state["collector_name"]] = "timeout"
                    if trace:
                        trace.emit(
                            "collector_end",
                            collector_name=state["collector_name"],
                            status="timeout",
                            duration_ms=(time.monotonic() - state["started_at"]) * 1000,
                        )
                    _stop_isolated_process(process, trace, state["collector_name"])
                    receiver.close()
                    active.remove(state)
            if active:
                time.sleep(0.005)
    finally:
        for state in active:
            statuses[state["collector_name"]] = "failed"
            if trace:
                trace.emit(
                    "collector_end",
                    collector_name=state["collector_name"],
                    status="failed",
                    duration_ms=(time.monotonic() - state["started_at"]) * 1000,
                )
            _stop_isolated_process(state["process"], trace, state["collector_name"])
            state["receiver"].close()
    return results, statuses


def _isolated_collector_entry(sender: Any, collector: Callable[[], Any]) -> None:
    try:
        if hasattr(os, "setsid"):
            os.setsid()
        sender.send(("ok", collector()))
    except BaseException:
        try:
            sender.send(("error", None))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        sender.close()


def _stop_isolated_process(
    process: multiprocessing.Process,
    trace: InspectionTrace | None = None,
    collector_name: str = "collector",
) -> None:
    if not process.is_alive():
        process.join(timeout=COLLECTOR_TERMINATION_GRACE_SECONDS)
        if trace:
            _trace_child_exit(process, trace, collector_name)
        return
    if trace:
        trace.emit(
            "terminate_requested",
            collector_name=collector_name,
            child_pid=process.pid,
            process_group_id=_safe_process_group_id(process.pid),
        )
    _signal_isolated_process(process, signal.SIGTERM)
    process.join(timeout=COLLECTOR_TERMINATION_GRACE_SECONDS)
    if process.is_alive():
        if trace:
            trace.emit(
                "kill_requested",
                collector_name=collector_name,
                child_pid=process.pid,
                process_group_id=_safe_process_group_id(process.pid),
            )
        _signal_isolated_process(process, signal.SIGKILL)
        process.join(timeout=COLLECTOR_TERMINATION_GRACE_SECONDS)
    if trace:
        _trace_child_exit(process, trace, collector_name)


def _trace_child_exit(
    process: multiprocessing.Process,
    trace: InspectionTrace,
    collector_name: str,
) -> None:
    trace.emit(
        "child_exit_observed",
        collector_name=collector_name,
        status="exited",
        child_pid=process.pid,
        exit_code=process.exitcode,
    )


def _safe_process_group_id(pid: int | None) -> int | None:
    if pid is None or not hasattr(os, "getpgid"):
        return None
    try:
        process_group_id = os.getpgid(pid)
    except (OSError, ProcessLookupError):
        return None
    return process_group_id if process_group_id == pid else None


def _collector_name(kind: str, port: int | None) -> str:
    return kind if port is None else f"{kind}_{port}"


def _signal_isolated_process(process: multiprocessing.Process, selected: signal.Signals) -> None:
    try:
        if hasattr(os, "getpgid") and os.getpgid(process.pid) == process.pid:
            os.killpg(process.pid, selected)
            return
    except (OSError, ProcessLookupError):
        return
    if selected == signal.SIGKILL and hasattr(process, "kill"):
        process.kill()
    else:
        process.terminate()


def _normalize_context(target: str, context: dict[str, Any]) -> dict[str, Any]:
    route_role = str(context.get("route_role", "routed"))
    if route_role not in {"default_gateway", "on_link", "routed"}:
        raise ValueError("Invalid route role")
    same_subnet = bool(context.get("same_subnet", route_role != "routed"))
    mac = normalize_mac(context.get("mac")) if same_subnet else None
    default_gateway = context.get("default_gateway")
    if route_role == "default_gateway" and default_gateway != target:
        raise ValueError("Default-gateway role does not match target")
    is_this_device = bool(context.get("is_this_device", False))
    interface_index = context.get("interface_index")
    if not isinstance(interface_index, int) or interface_index < 1:
        raise ValueError("Invalid Windows interface index")
    interface_type = str(context.get("interface_type", "unknown"))
    if interface_type not in {"physical", "virtual", "unknown"}:
        raise ValueError("Invalid Windows interface type")
    interface_alias = _clean_text(context.get("interface_alias"), 256)
    interface_description = _clean_text(context.get("interface_description"), 512)
    if not interface_alias:
        raise ValueError("Windows interface alias is required")
    return {
        "route_role": route_role,
        "same_subnet": same_subnet,
        "mac": mac,
        "reachable": bool(context.get("reachable", False)),
        "is_this_device": is_this_device,
        "interface_index": interface_index,
        "interface_alias": interface_alias,
        "interface_description": interface_description,
        "interface_type": interface_type,
    }


def normalize_mac(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    compact = re.sub(r"[^0-9A-Fa-f]", "", value)
    if len(compact) != 12 or compact == "0" * 12:
        return None
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2)).upper()


def is_locally_administered(mac: str) -> bool:
    return bool(int(mac.split(":")[0], 16) & 0x02)


def lookup_mac_vendor(mac: str) -> str | None:
    """Use Scapy's bundled offline manuf database; never call a cloud OUI API."""
    try:
        from scapy.config import conf
        vendor = conf.manufdb.lookup(mac)[0]
    except (ImportError, AttributeError, KeyError, TypeError, ValueError):
        return None
    if not vendor or vendor.upper() == mac.upper() or ":" in vendor:
        return None
    return _clean_text(vendor, 120)


def probe_tcp_service_states(
    target: str,
    deadline: _InspectionDeadline | None = None,
) -> list[dict[str, Any]]:
    """Probe only the fixed allow-list and retain conservative connection states."""
    def check(port: int) -> dict[str, Any]:
        state = "unknown"
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(_bounded_timeout(deadline, TCP_TIMEOUT_SECONDS))
                result = probe.connect_ex((target, port))
            if result == 0:
                state = "open"
            elif result == errno.ECONNREFUSED:
                state = "closed"
            elif result == errno.ETIMEDOUT:
                state = "timeout"
        except socket.timeout:
            state = "timeout"
        except OSError:
            state = "unknown"
        return {"name": SERVICE_NAMES[port], "protocol": "tcp", "port": port, "state": state}

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
    futures = {pool.submit(check, port): port for port in TCP_PORTS}
    completed: dict[int, dict[str, Any]] = {}
    try:
        pending = set(futures)
        while pending:
            wait_timeout = deadline.remaining() if deadline else None
            if wait_timeout is not None and wait_timeout <= 0:
                break
            done, pending = concurrent.futures.wait(
                pending,
                timeout=wait_timeout,
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            if not done:
                break
            for future in done:
                completed[futures[future]] = future.result()
        for future in pending:
            future.cancel()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return [completed[port] for port in TCP_PORTS if port in completed]


def probe_tcp_ports(target: str) -> list[int]:
    """Compatibility helper returning only open ports."""
    return [item["port"] for item in probe_tcp_service_states(target) if item["state"] == "open"]


def http_metadata(
    target: str,
    port: int,
    *,
    use_tls: bool = False,
    deadline: _InspectionDeadline | None = None,
) -> dict[str, Any] | None:
    request = (
        f"GET / HTTP/1.0\r\nHost: {target}\r\n"
        "User-Agent: NetOps-Quick-Inspector/1\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    try:
        with socket.create_connection((target, port), timeout=_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS)) as plain:
            connection: socket.socket = plain
            plain.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
            if use_tls:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                connection = context.wrap_socket(plain, server_hostname=target)
            connection.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
            connection.sendall(request)
            response = _receive_bounded(connection, MAX_HTTP_BYTES, deadline)
    except (OSError, ssl.SSLError, InspectionDeadlineExceeded):
        return None
    head, _, content = response.partition(b"\r\n\r\n")
    header_lines = head.decode("latin-1", errors="replace").splitlines()
    headers: dict[str, str] = {}
    status_match = re.match(r"HTTP/\d(?:\.\d)?\s+(\d{3})", header_lines[0] if header_lines else "")
    for line in header_lines[1:]:
        name, separator, value = line.partition(":")
        if separator and name.lower() in {"server", "x-powered-by", "content-type", "location"}:
            headers[name.lower()] = _clean_text(value, 200)
    title_match = re.search(rb"<title[^>]*>(.*?)</title>", content, flags=re.I | re.S)
    title = _clean_text(html.unescape(title_match.group(1).decode("utf-8", errors="replace")), 200) if title_match else ""
    result = {key: value for key, value in {
        "port": port,
        "scheme": "https" if use_tls else "http",
        "status": int(status_match.group(1)) if status_match else None,
        "title": title,
        "server": headers.get("server", ""),
        "powered_by": headers.get("x-powered-by", ""),
        "content_type": headers.get("content-type", ""),
        "location": _sanitize_http_location(headers.get("location", "")),
    }.items() if value not in {None, ""}}
    return result or None


def tls_metadata(
    target: str,
    port: int,
    deadline: _InspectionDeadline | None = None,
) -> dict[str, Any] | None:
    openssl = shutil.which("openssl")
    if not openssl:
        return None
    try:
        handshake = subprocess.run(
            [openssl, "s_client", "-connect", f"{target}:{port}", "-servername", target, "-showcerts"],
            input="", capture_output=True, text=True,
            timeout=_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS), check=False,
        )
        match = re.search(
            r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
            handshake.stdout[:MAX_TLS_OUTPUT_BYTES],
            re.S,
        )
        if not match:
            return None
        certificate = match.group(0)[:MAX_TLS_OUTPUT_BYTES]
        decoded = subprocess.run(
            [openssl, "x509", "-noout", "-subject", "-issuer", "-dates", "-ext", "subjectAltName", "-nameopt", "RFC2253"],
            input=certificate, capture_output=True, text=True,
            timeout=_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS), check=False,
        )
    except (OSError, subprocess.SubprocessError, InspectionDeadlineExceeded):
        return None
    fields: dict[str, str] = {}
    decoded_output = decoded.stdout[:MAX_TLS_OUTPUT_BYTES]
    for line in decoded_output.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"subject", "issuer", "notBefore", "notAfter"}:
            fields[{"notBefore": "valid_from", "notAfter": "valid_to"}.get(key, key)] = _clean_text(value, 300)
    subject = fields.get("subject", "")
    cn = re.search(r"(?:^|,)CN=([^,]+)", subject)
    if cn:
        fields["common_name"] = _clean_text(cn.group(1), 200)
    san_match = re.search(r"X509v3 Subject Alternative Name:\s*\n\s*([^\n]+)", decoded_output)
    if san_match:
        names: list[str] = []
        for value in san_match.group(1).split(","):
            candidate = value.strip()
            if candidate.startswith("DNS:"):
                names.append(_clean_text(candidate.removeprefix("DNS:"), 200))
            elif candidate.startswith("IP Address:"):
                names.append(_clean_text(candidate.removeprefix("IP Address:"), 80))
        if names:
            fields["subject_alt_names"] = names[:16]
    fields["port"] = port
    return fields or None


def upnp_metadata(
    target: str,
    deadline: _InspectionDeadline | None = None,
) -> dict[str, Any] | None:
    message = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {target}:1900\r\n"
        'MAN: "ssdp:discover"\r\nMX: 1\r\nST: upnp:rootdevice\r\n\r\n'
    ).encode("ascii")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
            udp.sendto(message, (target, 1900))
            response, address = udp.recvfrom(8192)
    except OSError:
        return None
    if address[0] != target:
        return None
    location = None
    for line in response.decode("latin-1", errors="replace").splitlines():
        name, separator, value = line.partition(":")
        if separator and name.lower() == "location":
            location = value.strip()
            break
    if not location:
        return {"detected": True}
    parsed = urlsplit(location)
    try:
        resolved = _resolve_ipv4_bounded(parsed.hostname or "", deadline)
    except (OSError, InspectionDeadlineExceeded):
        return {"detected": True, "location_rejected": True, "rejection_reason": "unresolvable_host"}
    if parsed.scheme != "http" or resolved != target or parsed.username or parsed.password:
        return {"detected": True, "location_rejected": True, "rejection_reason": "unsafe_location"}
    try:
        port = parsed.port or 80
    except ValueError:
        return {"detected": True, "location_rejected": True, "rejection_reason": "invalid_port"}
    if not 1 <= port <= 65535:
        return {"detected": True, "location_rejected": True, "rejection_reason": "invalid_port"}
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    request = f"GET {path} HTTP/1.0\r\nHost: {target}:{port}\r\nUser-Agent: NetOps-Quick-Inspector/1\r\nConnection: close\r\n\r\n".encode("ascii", errors="ignore")
    try:
        with socket.create_connection((target, port), timeout=_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS)) as connection:
            connection.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
            connection.sendall(request)
            response = _receive_bounded(connection, MAX_UPNP_BYTES, deadline)
    except (OSError, InspectionDeadlineExceeded):
        return {"detected": True}
    head, _, xml_data = response.partition(b"\r\n\r\n")
    status = re.match(rb"HTTP/\d(?:\.\d)?\s+(\d{3})", head)
    if status and 300 <= int(status.group(1)) < 400:
        return {"detected": True, "description_rejected": True, "rejection_reason": "redirect_not_followed"}
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError:
        return {"detected": True}
    wanted = {"deviceType", "friendlyName", "manufacturer", "modelDescription", "modelName", "modelNumber"}
    result: dict[str, Any] = {"detected": True}
    services: list[str] = []
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1]
        if name in wanted and element.text and name not in result:
            result[name] = _clean_text(element.text, 300)
        elif name == "serviceType" and element.text and len(services) < 16:
            services.append(_clean_text(element.text, 300))
    if services:
        result["service_types"] = services
    return result


def netbios_metadata(
    target: str,
    deadline: _InspectionDeadline | None = None,
) -> dict[str, str] | None:
    """Request one NetBIOS node-status response; never enumerate shares or users."""
    wildcard = b"*" + (b" " * 15)
    encoded = b"".join(bytes((65 + (byte >> 4), 65 + (byte & 0x0F))) for byte in wildcard)
    transaction_id = 0x4E4D
    query = struct.pack("!HHHHHH", transaction_id, 0, 1, 0, 0, 0)
    query += bytes((len(encoded),)) + encoded + b"\x00" + struct.pack("!HH", 0x21, 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
            udp.sendto(query, (target, 137))
            response, address = udp.recvfrom(MAX_NETBIOS_BYTES)
    except OSError:
        return None
    if address[0] != target or len(response) < 20:
        return None
    try:
        offset = 12
        while offset < len(response) and response[offset]:
            offset += response[offset] + 1
        offset += 5
        if response[offset] & 0xC0 == 0xC0:
            offset += 2
        else:
            while offset < len(response) and response[offset]:
                offset += response[offset] + 1
            offset += 1
        offset += 10
        count = response[offset]
        offset += 1
        for _ in range(min(count, 64)):
            entry = response[offset:offset + 18]
            offset += 18
            if len(entry) < 18:
                break
            suffix = entry[15]
            flags = struct.unpack("!H", entry[16:18])[0]
            if suffix == 0x00 and not flags & 0x8000:
                hostname = _clean_text(entry[:15].decode("ascii", errors="ignore").rstrip(), 15)
                if hostname:
                    return {"hostname": hostname}
    except (IndexError, struct.error, ValueError):
        return None
    return None


def classify_device(observed: dict[str, Any]) -> dict[str, Any]:
    """Normalize evidence and classify conservatively; suitable for controlled fixtures."""
    upnp = observed.get("upnp") if isinstance(observed.get("upnp"), dict) else {}
    raw_http = observed.get("http")
    http_items = raw_http if isinstance(raw_http, list) else [raw_http] if isinstance(raw_http, dict) else []
    http_items = [item for item in http_items if isinstance(item, dict)]
    raw_tls = observed.get("tls")
    tls_items = raw_tls if isinstance(raw_tls, list) else [raw_tls] if isinstance(raw_tls, dict) else []
    tls_items = [item for item in tls_items if isinstance(item, dict)]
    primary_tls = tls_items[0] if tls_items else {}
    netbios = observed.get("netbios") if isinstance(observed.get("netbios"), dict) else {}
    ports = [int(port) for port in observed.get("open_ports", []) if int(port) in TCP_PORTS]
    tcp_states = [
        {"name": SERVICE_NAMES[int(item["port"])], "protocol": "tcp", "port": int(item["port"]), "state": item["state"]}
        for item in observed.get("tcp_states", [])
        if isinstance(item, dict)
        and item.get("state") in {"open", "closed", "filtered", "unknown", "timeout"}
        and str(item.get("port", "")).isdigit()
        and int(item["port"]) in TCP_PORTS
    ]
    raw_collector_statuses = observed.get("collector_statuses")
    collector_statuses = {
        _clean_text(name, 80): status
        for name, status in raw_collector_statuses.items()
        if isinstance(name, str)
        and status in {"completed", "timeout", "failed", "skipped_budget"}
        and _clean_text(name, 80)
    } if isinstance(raw_collector_statuses, dict) else {}
    deadline_reached = bool(observed.get("deadline_reached"))
    collector_incomplete = any(status != "completed" for status in collector_statuses.values())
    partial = bool(observed.get("partial")) or collector_incomplete or deadline_reached
    route_role = observed.get("route_role") if observed.get("route_role") in {"default_gateway", "on_link", "routed"} else "routed"
    is_this_device = bool(observed.get("is_this_device"))
    interface_type = observed.get("interface_type") if observed.get("interface_type") in {"physical", "virtual", "unknown"} else "unknown"
    interface_alias = _clean_text(observed.get("interface_alias"), 256) or None
    interface_description = _clean_text(observed.get("interface_description"), 512) or None
    vendor = observed.get("mac_vendor") if observed.get("mac_kind") == "global" else None
    manufacturer = _clean_text(upnp.get("manufacturer"), 120) or None
    model = _clean_text(upnp.get("modelName") or upnp.get("friendlyName"), 160) or None
    model_number = _clean_text(upnp.get("modelNumber"), 80) or None
    upnp_detected = bool(upnp.get("detected") or upnp.get("deviceType") or manufacturer or model)
    capabilities: list[str] = []
    evidence: list[dict[str, str]] = []
    software: list[str] = []
    device_type = "unknown"
    confidence = "unknown"

    if is_this_device:
        capabilities.append("local_host")
        if interface_type == "virtual":
            capabilities.append("virtual_interface")
        evidence.append({"source": "network_context", "label": "Automated network role", "value": "This Device"})
        interface_value = " · ".join(value for value in (interface_alias, interface_description, interface_type) if value)
        if interface_value:
            evidence.append({"source": "network_context", "label": "Windows interface", "value": interface_value})

    if route_role == "default_gateway":
        capabilities.append("gateway")
        evidence.append({"source": "route", "label": "Default route", "value": "This IP is the active default gateway"})
    if observed.get("mac"):
        value = "Randomized / locally administered MAC" if observed.get("mac_kind") == "locally_administered" else str(vendor or "Vendor unavailable")
        evidence.append({"source": "mac_oui", "label": "MAC OUI", "value": value})
    if upnp_detected:
        capabilities.append("upnp")
        if upnp.get("deviceType"):
            evidence.append({"source": "upnp", "label": "UPnP device type", "value": _clean_text(upnp["deviceType"], 300)})
        if manufacturer:
            evidence.append({"source": "upnp", "label": "UPnP manufacturer", "value": manufacturer})
        if model:
            evidence.append({"source": "upnp", "label": "UPnP model", "value": model})
        if upnp.get("location_rejected") or upnp.get("description_rejected"):
            evidence.append({"source": "upnp", "label": "UPnP description", "value": "Unsafe or redirected LOCATION was rejected; no external request was made"})
    services = [{"name": SERVICE_NAMES[port], "protocol": "tcp", "port": port} for port in ports]
    if upnp_detected:
        services.append({"name": "UPnP", "protocol": "udp", "port": 1900})
    if netbios.get("hostname"):
        services.append({"name": "NetBIOS Node Status", "protocol": "udp", "port": 137})
        evidence.append({"source": "netbios", "label": "Windows / NetBIOS hostname", "value": _clean_text(netbios["hostname"], 15)})
    server = " ".join(
        str(item.get(key, ""))
        for item in http_items
        for key in ("server", "powered_by", "title")
    )
    lower_server = server.lower()
    for name, pattern in (
        ("Apache", r"apache(?:/[^\s;()]+)?"),
        ("PHP", r"php(?:/[^\s;()]+)?"),
        ("OpenSSL", r"openssl(?:/[^\s;()]+)?"),
    ):
        match = re.search(pattern, server, re.I)
        if match:
            software.append(_clean_text(match.group(0), 80))
    if "laragon" in lower_server:
        software.append("Laragon")
    for item in http_items:
        endpoint = f"{str(item.get('scheme', 'http')).upper()} TCP/{item.get('port', 80)}"
        details = " · ".join(
            _clean_text(value, 200) for value in (
                f"status {item['status']}" if item.get("status") else "",
                item.get("server"), item.get("powered_by"), item.get("content_type"),
                f"title {item['title']}" if item.get("title") else "",
                f"Location {item['location']}" if item.get("location") else "",
            ) if value
        )
        evidence.append({"source": "http", "label": endpoint, "value": details or "HTTP responded"})
    for item in tls_items:
        identity = item.get("common_name") or ", ".join(item.get("subject_alt_names", []))
        details = " · ".join(_clean_text(value, 220) for value in (
            f"CN {item['common_name']}" if item.get("common_name") else "",
            f"SAN {', '.join(item.get('subject_alt_names', []))}" if item.get("subject_alt_names") else "",
            f"Issuer {item['issuer']}" if item.get("issuer") else "",
            f"Valid {item.get('valid_from', '?')} — {item.get('valid_to', '?')}" if item.get("valid_from") or item.get("valid_to") else "",
        ) if value)
        if identity or details:
            evidence.append({"source": "tls", "label": f"TLS TCP/{item.get('port', 443)}", "value": details or _clean_text(identity, 200)})

    device_type_text = str(upnp.get("deviceType", "")).lower()
    services_text = " ".join(str(item) for item in upnp.get("service_types", [])).lower()
    model_lower = (model or "").lower()
    if is_this_device:
        confidence = "high"
    elif route_role == "default_gateway" and ("internetgatewaydevice" in device_type_text or model):
        device_type, confidence = "router", "high"
        if "layer3forwarding" in services_text:
            capabilities.append("layer3_forwarding")
        if any(marker in model_lower for marker in ("archer", "wireless", "wifi", "wi-fi")):
            capabilities.append("wifi_ap")
    elif "internetgatewaydevice" in device_type_text:
        device_type, confidence = "router", "medium"
    elif any(marker in lower_server for marker in ("laragon", "apache") ) and ("win64" in lower_server or "laragon" in lower_server):
        device_type, confidence = "workstation", "medium"
    elif 9100 in ports or 631 in ports:
        device_type, confidence = "printer", "medium"
    elif 554 in ports:
        device_type, confidence = "camera", "low"
    elif observed.get("reachable") or ports:
        confidence = "low" if ports else "unknown"

    os_family = "Windows" if is_this_device or "win64" in lower_server or "laragon" in lower_server else None
    likely_label = " ".join(value for value in (manufacturer, model) if value) or None
    if is_this_device:
        likely_label = "Local Windows virtual interface" if interface_type == "virtual" else "This Windows device"
    elif not likely_label and device_type == "workstation":
        likely_label = "Windows endpoint / development machine"
    elif not likely_label and netbios.get("hostname"):
        likely_label = _clean_text(netbios["hostname"], 15)
    limitations = ["Observed services use a bounded allow-list; untested ports are not reported as closed."]
    if not observed.get("same_subnet"):
        limitations.append("Target is routed; target MAC is unavailable and next-hop MAC is not used.")
    limitations.extend(["Unmanaged Layer-2 switches without a management IP may not be discoverable.", "MTR shows responding Layer-3 hops, not every Layer-2 switch."])
    return {
        "schema_version": 1,
        "ip": observed["ip"],
        "reachable": bool(observed.get("reachable")),
        "route_role": route_role,
        "same_subnet": bool(observed.get("same_subnet")),
        "network_context": {
            "is_this_device": is_this_device,
            "automated_role": "this_device" if is_this_device else None,
            "interface_index": observed.get("interface_index"),
            "interface_alias": interface_alias,
            "interface_description": interface_description,
            "interface_type": interface_type,
        },
        "network_identity": {
            "mac": observed.get("mac") if observed.get("same_subnet") else None,
            "mac_kind": observed.get("mac_kind", "unavailable") if observed.get("same_subnet") else "unavailable",
            "mac_vendor": vendor,
            "tls_identity": primary_tls.get("common_name") or next(iter(primary_tls.get("subject_alt_names", [])), None),
        },
        "detected_identity": {"manufacturer": manufacturer, "model": model, "model_number": model_number, "os_family": os_family, "likely_label": likely_label},
        "likely_device_type": device_type,
        "capabilities": sorted(set(capabilities)),
        "confidence": confidence,
        "observed_services": services,
        "observed_software": sorted(set(software)),
        "evidence": evidence[:32],
        "probe_summary": {
            "tcp_ports_checked": [item["port"] for item in tcp_states],
            "tcp_open_count": len(ports),
            "tcp_states": tcp_states,
            "upnp_checked": (
                collector_statuses.get("upnp") == "completed"
                if "upnp" in collector_statuses else not partial
            ) or upnp_detected,
            "netbios_checked": 445 in ports and (
                (collector_statuses.get("netbios") == "completed" if "netbios" in collector_statuses else not partial)
                or bool(netbios)
            ),
            "collector_statuses": collector_statuses,
            "partial": partial,
            "deadline_reached": deadline_reached,
            "optional_skips": [
                "mdns",
                *(name for name, status in collector_statuses.items() if status == "skipped_budget"),
                *(["deadline"] if deadline_reached else []),
            ],
        },
        "limitations": limitations,
    }


def _receive_bounded(
    connection: socket.socket,
    maximum: int,
    deadline: _InspectionDeadline | None = None,
) -> bytes:
    chunks: list[bytes] = []
    remaining = maximum
    while remaining > 0:
        if deadline:
            connection.settimeout(_bounded_timeout(deadline, METADATA_TIMEOUT_SECONDS))
        chunk = connection.recv(min(4096, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _bounded_timeout(deadline: _InspectionDeadline | None, maximum: float) -> float:
    return deadline.timeout(maximum) if deadline else maximum


def _resolve_ipv4_bounded(hostname: str, deadline: _InspectionDeadline | None) -> str:
    try:
        return str(ipaddress.ip_address(hostname))
    except ValueError:
        pass
    if not deadline:
        return socket.gethostbyname(hostname)
    try:
        resolution = subprocess.run(
            [sys.executable, "-c", "import socket,sys;print(socket.gethostbyname(sys.argv[1]))", hostname],
            capture_output=True,
            text=True,
            timeout=deadline.timeout(METADATA_TIMEOUT_SECONDS),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise OSError("Hostname resolution failed") from error
    if resolution.returncode != 0:
        raise OSError("Hostname resolution failed")
    value = resolution.stdout.strip()
    if not value or ipaddress.ip_address(value).version != 4:
        raise OSError("Hostname did not resolve to IPv4")
    return value


def _has_usable_evidence(observed: dict[str, Any]) -> bool:
    return bool(
        observed.get("reachable")
        or observed.get("is_this_device")
        or observed.get("mac")
        or observed.get("open_ports")
        or observed.get("http")
        or observed.get("tls")
        or observed.get("upnp")
        or observed.get("netbios")
    )


def _clean_text(value: Any, maximum: int) -> str:
    if value is None:
        return ""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value)).strip()[:maximum]


def _sanitize_http_location(value: str) -> str:
    """Keep routing identity while dropping query, fragment, and embedded credentials."""
    cleaned = _clean_text(value, 500)
    if not cleaned:
        return ""
    parsed = urlsplit(cleaned)
    if not parsed.scheme and not parsed.netloc:
        return _clean_text(parsed.path or "/", 200)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "Location present but not retained"
    try:
        port = f":{parsed.port}" if parsed.port else ""
    except ValueError:
        return "Location present but not retained"
    return _clean_text(f"{parsed.scheme}://{parsed.hostname}{port}{parsed.path or '/'}", 300)
