"""Cross-platform basic network metric and health collection."""

from __future__ import annotations

import math
import platform
import re
import socket
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import psutil


@dataclass(frozen=True)
class DefaultRoute:
    gateway_ip: str | None
    interface: str | None


@dataclass(frozen=True)
class CounterSnapshot:
    captured_at: float
    bytes_received: int
    bytes_sent: int
    packets_received: int
    packets_sent: int


def discover_default_route() -> DefaultRoute:
    if platform.system() == "Windows":
        return _discover_windows_route()
    return _discover_unix_route()


def select_interface(preferred: str | None, route_interface: str | None) -> str:
    counters = psutil.net_io_counters(pernic=True)
    stats = psutil.net_if_stats()

    if preferred:
        if preferred not in counters:
            available = ", ".join(sorted(counters))
            raise ValueError(
                f"NETWORK_INTERFACE '{preferred}' not found. Available: {available}"
            )
        return preferred

    if route_interface and route_interface in counters:
        return route_interface

    candidates = [
        name
        for name, interface_stats in stats.items()
        if interface_stats.isup
        and name in counters
        and not name.lower().startswith(("lo", "loopback"))
    ]
    if not candidates:
        raise RuntimeError("No active non-loopback network interface found")

    return max(
        candidates,
        key=lambda name: counters[name].bytes_recv + counters[name].bytes_sent,
    )


def capture_snapshot(interface: str) -> CounterSnapshot:
    counters = psutil.net_io_counters(pernic=True)
    if interface not in counters:
        raise RuntimeError(f"Network interface '{interface}' is no longer available")

    current = counters[interface]
    return CounterSnapshot(
        captured_at=time.monotonic(),
        bytes_received=current.bytes_recv,
        bytes_sent=current.bytes_sent,
        packets_received=current.packets_recv,
        packets_sent=current.packets_sent,
    )


def collect_metrics(
    previous: CounterSnapshot,
    current: CounterSnapshot,
    gateway_ip: str | None,
    dns_test_host: str,
) -> dict[str, Any]:
    gateway_reachable, latency_ms = ping_target(gateway_ip)
    dns_reachable = resolve_dns(dns_test_host)
    interval_seconds = max(1, round(current.captured_at - previous.captured_at))

    return {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "interval_seconds": interval_seconds,
        "bytes_in": _counter_delta(current.bytes_received, previous.bytes_received),
        "bytes_out": _counter_delta(current.bytes_sent, previous.bytes_sent),
        "packet_count": _counter_delta(
            current.packets_received + current.packets_sent,
            previous.packets_received + previous.packets_sent,
        ),
        "avg_latency_ms": round(latency_ms, 2) if latency_ms is not None else None,
        "packet_loss_pct": 0.0 if gateway_reachable else 100.0,
        "gateway_reachable": gateway_reachable,
        "dns_reachable": dns_reachable,
        "protocol_breakdown": {},
    }


def ping_target(target: str | None, timeout_seconds: float = 2.0) -> tuple[bool, float | None]:
    if not target:
        return False, None

    if platform.system() == "Windows":
        command = ["ping", "-n", "1", "-w", str(round(timeout_seconds * 1000)), target]
    else:
        command = ["ping", "-c", "1", "-W", str(math.ceil(timeout_seconds)), target]

    started_at = time.perf_counter()
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=timeout_seconds + 1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, None

    elapsed_ms = (time.perf_counter() - started_at) * 1000
    return (result.returncode == 0, elapsed_ms if result.returncode == 0 else None)


def resolve_dns(hostname: str) -> bool:
    try:
        socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        return True
    except (OSError, socket.gaierror):
        return False


def _discover_unix_route() -> DefaultRoute:
    try:
        result = subprocess.run(
            ["ip", "-4", "route", "show", "default"],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return DefaultRoute(None, None)

    match = re.search(r"^default(?:\s+via\s+(\S+))?.*?\sdev\s+(\S+)", result.stdout, re.MULTILINE)
    if not match:
        return DefaultRoute(None, None)
    return DefaultRoute(match.group(1), match.group(2))


def _discover_windows_route() -> DefaultRoute:
    try:
        result = subprocess.run(
            ["route", "print", "-4", "0.0.0.0"],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return DefaultRoute(None, None)

    candidates: list[tuple[int, str]] = []
    pattern = re.compile(
        r"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+"
        r"\d{1,3}(?:\.\d{1,3}){3}\s+(\d+)\s*$",
        re.MULTILINE,
    )
    for gateway, metric in pattern.findall(result.stdout):
        candidates.append((int(metric), gateway))

    if not candidates:
        return DefaultRoute(None, None)
    _, gateway = min(candidates)
    return DefaultRoute(gateway, None)


def _counter_delta(current: int, previous: int) -> int:
    return max(0, current - previous)

