"""Header-only packet metadata extraction and bounded directional flow aggregation."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from scapy.layers.inet import ICMP, IP, TCP, UDP


@dataclass(frozen=True)
class PacketMetadata:
    src_ip: str
    dst_ip: str
    src_port: int | None
    dst_port: int | None
    protocol: str
    size_bytes: int
    timestamp: str


@dataclass
class FlowState:
    first_seen: datetime
    last_seen: datetime
    total_bytes: int = 0
    packet_count: int = 0
    interval_bytes: int = 0
    interval_packets: int = 0
    peak_rate_mbps: float = 0.0
    previous_rate_mbps: float = 0.0


def extract_packet_metadata(packet: Any) -> PacketMetadata | None:
    """Return only IPv4 TCP/UDP/ICMP header metadata; never retain the packet."""
    try:
        if not packet.haslayer(IP):
            return None
        ip = packet[IP]
        src_port: int | None = None
        dst_port: int | None = None
        if packet.haslayer(TCP):
            protocol = "tcp"
            src_port, dst_port = int(packet[TCP].sport), int(packet[TCP].dport)
        elif packet.haslayer(UDP):
            protocol = "udp"
            src_port, dst_port = int(packet[UDP].sport), int(packet[UDP].dport)
        elif packet.haslayer(ICMP):
            protocol = "icmp"
        else:
            return None
        observed = datetime.fromtimestamp(float(packet.time), timezone.utc)
        return PacketMetadata(
            src_ip=str(ip.src), dst_ip=str(ip.dst), src_port=src_port,
            dst_port=dst_port, protocol=protocol, size_bytes=int(len(packet)),
            timestamp=observed.isoformat().replace("+00:00", "Z"),
        )
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return None


def flow_key(metadata: PacketMetadata) -> str:
    raw = "|".join(
        (metadata.src_ip, metadata.dst_ip, str(metadata.src_port or ""),
         str(metadata.dst_port or ""), metadata.protocol)
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def inferred_service(protocol: str, src_port: int | None, dst_port: int | None) -> str | None:
    ports = {src_port, dst_port}
    known = {53: "DNS", 67: "DHCP", 68: "DHCP", 80: "HTTP", 123: "NTP",
             443: "HTTPS", 445: "SMB", 5201: "iperf3"}
    for port, name in known.items():
        if port in ports:
            return f"{name} (inferred)"
    return "ICMP" if protocol == "icmp" else None


class FlowAggregator:
    """Thread-safe-enough callback aggregator (one sniffer writer, one snapshot reader)."""

    def __init__(self, *, max_flows: int = 100, active_seconds: int = 5,
                 idle_seconds: int = 15, expire_seconds: int = 30,
                 local_ips: set[str] | None = None, max_states: int = 1000) -> None:
        self.max_flows = max_flows
        self.active_seconds = active_seconds
        self.idle_seconds = idle_seconds
        self.expire_seconds = expire_seconds
        self.local_ips = local_ips or set()
        self.max_states = max_states
        self._flows: dict[tuple[str, str, int | None, int | None, str], FlowState] = {}

    def observe(self, metadata: PacketMetadata) -> None:
        key = (metadata.src_ip, metadata.dst_ip, metadata.src_port,
               metadata.dst_port, metadata.protocol)
        seen = datetime.fromisoformat(metadata.timestamp.replace("Z", "+00:00"))
        state = self._flows.get(key)
        if state is None:
            if len(self._flows) >= self.max_states:
                oldest = min(self._flows, key=lambda item: self._flows[item].last_seen)
                del self._flows[oldest]
            state = FlowState(first_seen=seen, last_seen=seen)
            self._flows[key] = state
        state.last_seen = max(state.last_seen, seen)
        state.total_bytes += metadata.size_bytes
        state.packet_count += 1
        state.interval_bytes += metadata.size_bytes
        state.interval_packets += 1

    def snapshot(self, now: datetime | None = None, interval_seconds: float = 2.0) -> dict[str, Any]:
        current = now or datetime.now(timezone.utc)
        expired = [key for key, state in self._flows.items()
                   if (current - state.last_seen).total_seconds() > self.expire_seconds]
        for key in expired:
            del self._flows[key]

        rows: list[dict[str, Any]] = []
        rx_bytes = tx_bytes = total_packets = interval_packets = 0
        protocol_bytes: dict[str, int] = defaultdict(int)
        for key, state in list(self._flows.items()):
            src, dst, sport, dport, protocol = key
            age = max(0.0, (current - state.last_seen).total_seconds())
            rate = state.interval_bytes * 8 / max(interval_seconds, 0.001) / 1_000_000
            state.peak_rate_mbps = max(state.peak_rate_mbps, rate)
            delta = rate - state.previous_rate_mbps
            trend = "increasing" if delta > 0.01 else "decreasing" if delta < -0.01 else "stable"
            row = {
                "flow_key": flow_key(PacketMetadata(src, dst, sport, dport, protocol, 0, state.last_seen.isoformat())),
                "src_ip": src, "dst_ip": dst, "src_port": sport, "dst_port": dport,
                "protocol": protocol, "service": inferred_service(protocol, sport, dport),
                "first_seen": state.first_seen.isoformat(), "last_seen": state.last_seen.isoformat(),
                "total_bytes": state.total_bytes, "packet_count": state.packet_count,
                "bytes_delta": state.interval_bytes, "packets_delta": state.interval_packets,
                "packets_per_second": round(state.interval_packets / max(interval_seconds, 0.001), 2),
                "rate_mbps": round(rate, 4), "peak_rate_mbps": round(state.peak_rate_mbps, 4),
                "rate_trend": trend,
                "status": "active" if age <= self.active_seconds else "idle",
            }
            rows.append(row)
            if self.local_ips and dst in self.local_ips:
                rx_bytes += state.interval_bytes
            elif not self.local_ips or src in self.local_ips:
                tx_bytes += state.interval_bytes
            total_packets += state.packet_count
            interval_packets += state.interval_packets
            protocol_bytes[protocol] += state.interval_bytes
            state.previous_rate_mbps = rate
            state.interval_bytes = 0
            state.interval_packets = 0
        rows.sort(key=lambda item: (item["rate_mbps"], item["total_bytes"]), reverse=True)
        rows = rows[: self.max_flows]
        conversations = self._conversations(rows)[:30]
        talkers = self._talkers(rows)[:10]
        dominant = max(protocol_bytes, key=protocol_bytes.get) if protocol_bytes else None
        return {
            "captured_at": current.isoformat().replace("+00:00", "Z"),
            "summary": {"observed_tx_mbps": round(tx_bytes * 8 / max(interval_seconds, .001) / 1_000_000, 4),
                        "observed_rx_mbps": round(rx_bytes * 8 / max(interval_seconds, .001) / 1_000_000, 4),
                        "packets_observed": total_packets,
                        "packets_per_second": round(interval_packets / max(interval_seconds, 0.001), 2),
                        "active_flows": sum(r["status"] == "active" for r in rows),
                        "dominant_protocol": dominant},
            "flows": rows, "conversations": conversations, "top_talkers": talkers,
        }

    @staticmethod
    def _conversations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            a, b = sorted((row["src_ip"], row["dst_ip"]))
            item = grouped.setdefault((a, b), {"endpoint_a": a, "endpoint_b": b,
                                                    "a_to_b_bytes": 0, "b_to_a_bytes": 0,
                                                    "total_bytes": 0, "rate_mbps": 0.0,
                                                    "active_flows": 0,
                                                    "first_seen": row["first_seen"],
                                                    "last_seen": row["last_seen"],
                                                    "protocols": set(), "services": set()})
            field = "a_to_b_bytes" if row["src_ip"] == a else "b_to_a_bytes"
            item[field] += row["total_bytes"]
            item["total_bytes"] += row["total_bytes"]
            item["rate_mbps"] += row["rate_mbps"]
            item["active_flows"] += 1 if row["status"] == "active" else 0
            item["first_seen"] = min(item["first_seen"], row["first_seen"])
            item["last_seen"] = max(item["last_seen"], row["last_seen"])
            item["protocols"].add(row["protocol"])
            if row["service"]:
                item["services"].add(row["service"])
        result = []
        for item in grouped.values():
            protocols = sorted(item.pop("protocols"))
            services = sorted(item.pop("services"))
            item["protocol"] = protocols[0] if len(protocols) == 1 else "mixed"
            item["service"] = services[0] if len(services) == 1 else "Mixed" if services else None
            item["rate_mbps"] = round(item["rate_mbps"], 4)
            result.append(item)
        return sorted(result, key=lambda item: item["rate_mbps"], reverse=True)

    @staticmethod
    def _talkers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = grouped.setdefault(row["src_ip"], {"ip": row["src_ip"], "rate_mbps": 0.0, "total_bytes": 0, "active_flows": 0})
            item["rate_mbps"] += row["rate_mbps"]
            item["total_bytes"] += row["total_bytes"]
            item["active_flows"] += 1 if row["status"] == "active" else 0
        return sorted(grouped.values(), key=lambda item: item["rate_mbps"], reverse=True)
