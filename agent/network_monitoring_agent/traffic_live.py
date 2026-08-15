"""Bounded on-demand Scapy capture lifecycle, isolated from traffic_metrics."""

from __future__ import annotations
import json
import socket
import ipaddress
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from scapy.sendrecv import AsyncSniffer
import psutil

from .flows import FlowAggregator, extract_packet_metadata
from .traffic_buffer import TrafficBuffer
from .traffic_delivery import TrafficClient, TrafficDeliveryError


def resolve_capture_interface(configured: str) -> str:
    interfaces = psutil.net_if_addrs()
    if configured != "auto_ipv4":
        if configured not in interfaces:
            raise ValueError("Configured Traffic interface is unavailable")
        return configured
    candidates: list[str] = []
    for name, addresses in interfaces.items():
        if name == "lo":
            continue
        for address in addresses:
            if address.family != socket.AF_INET:
                continue
            parsed = ipaddress.ip_address(address.address)
            if not parsed.is_loopback and not parsed.is_link_local:
                candidates.append(name)
                break
    if len(candidates) != 1:
        raise ValueError("Automatic Traffic interface selection is ambiguous")
    return candidates[0]


def run_traffic_capture(*, runner_id: str, session_id: str, duration_seconds: int,
                        interface: str, client: TrafficClient,
                        buffer_path: Path, emit: Callable[[dict[str, object]], None],
                        snapshot_interval: float = 2.0, persist_interval: float = 10.0) -> None:
    if duration_seconds not in (300, 600, 900, 1800):
        raise ValueError("Traffic duration is not authorized")
    interface = resolve_capture_interface(interface)
    local_ips = {address.address for address in psutil.net_if_addrs().get(interface, [])
                 if address.family == socket.AF_INET}
    aggregator = FlowAggregator(local_ips=local_ips)
    buffer = TrafficBuffer(buffer_path)

    def consume(packet: object) -> None:
        metadata = extract_packet_metadata(packet)
        if metadata is not None:
            aggregator.observe(metadata)

    sniffer = AsyncSniffer(iface=interface, prn=consume, store=False)
    started = time.monotonic()
    last_persist = started
    emit({"type": "stage", "stage": "capturing", "status": "started"})
    sniffer.start()
    latest_rows: list[dict[str, object]] = []
    try:
        while time.monotonic() - started < duration_seconds:
            time.sleep(snapshot_interval)
            snapshot = aggregator.snapshot(datetime.now(timezone.utc), snapshot_interval)
            rows = snapshot["flows"]
            assert isinstance(rows, list)
            latest_rows = rows
            try:
                control = client.snapshot(runner_id, session_id, snapshot)
                if control.get("stop_requested") is True:
                    break
            except TrafficDeliveryError:
                pass  # Ephemeral snapshot may be sacrificed under network pressure.
            if time.monotonic() - last_persist >= persist_interval:
                buffer.put_many(session_id, rows)
                batch = buffer.pending(session_id, 100)
                if batch:
                    try:
                        client.flows(runner_id, session_id, batch)
                        buffer.acknowledge(session_id, [str(row["flow_key"]) for row in batch])
                    except TrafficDeliveryError:
                        pass
                last_persist = time.monotonic()
    finally:
        if sniffer.running:
            sniffer.stop()
        if latest_rows:
            buffer.put_many(session_id, latest_rows)
            final_batch = buffer.pending(session_id, 100)
            if final_batch:
                try:
                    client.flows(runner_id, session_id, final_batch)
                    buffer.acknowledge(
                        session_id,
                        [str(row["flow_key"]) for row in final_batch],
                    )
                except TrafficDeliveryError:
                    pass
        buffer.close()
    emit({"type": "complete", "session_id": session_id})
