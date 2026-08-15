"""On-demand bandwidth and path diagnostics using JSON subprocess output."""

from __future__ import annotations

import ipaddress
import json
import shutil
import subprocess
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Literal


ConnectionType = Literal["wifi", "ethernet"]
Direction = Literal["upload", "download"]
DiagnosticEnvironment = Literal["lan", "localhost_demo"]
VALID_CONNECTION_TYPES = frozenset({"wifi", "ethernet"})


class DiagnosticCommandError(RuntimeError):
    """Raised when a diagnostic executable fails or returns invalid JSON."""


@dataclass(frozen=True)
class BandwidthMeasurement:
    source_label: str
    target_label: str
    target_host: str
    connection_type: ConnectionType
    bitrate_mbps: float
    jitter_ms: float | None
    measured_at: str
    job_id: str | None = None
    direction: Direction | None = None
    environment: DiagnosticEnvironment | None = None
    peak_mbps: float | None = None
    minimum_mbps: float | None = None
    transferred_mb: float | None = None
    retransmits: int | None = None
    duration_seconds: float | None = None

    def as_payload(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HopMeasurement:
    session_id: str
    source_label: str
    target_label: str
    target_host: str
    connection_type: ConnectionType
    hop_number: int
    hop_ip: str | None
    avg_latency_ms: float | None
    loss_percent: float
    measured_at: str
    job_id: str | None = None
    environment: DiagnosticEnvironment | None = None

    def as_payload(self) -> dict[str, Any]:
        return asdict(self)


def run_iperf3(
    target: str,
    source_label: str,
    target_label: str,
    connection_type: ConnectionType,
    *,
    port: int = 5201,
    duration_seconds: int = 10,
    timeout_seconds: float = 45.0,
    binary: str = "iperf3",
) -> BandwidthMeasurement:
    payload = _run_json_command(
        binary,
        ["-c", target, "-p", str(port), "-4", "-t", str(duration_seconds), "-J"],
        timeout_seconds,
    )
    return parse_iperf3_json(
        payload,
        source_label,
        target_label,
        target,
        connection_type,
        direction="upload",
        environment=measurement_environment(target),
    )


def run_mtr(
    target: str,
    source_label: str,
    target_label: str,
    connection_type: ConnectionType,
    *,
    count: int = 5,
    timeout_seconds: float = 120.0,
    binary: str = "mtr",
    job_id: str | None = None,
    environment: DiagnosticEnvironment | None = None,
) -> list[HopMeasurement]:
    payload = _run_json_command(
        binary,
        ["--json", "--no-dns", "-c", str(count), target],
        timeout_seconds,
    )
    return parse_mtr_json(
        payload,
        source_label,
        target_label,
        target,
        connection_type,
        job_id=job_id,
        environment=environment or measurement_environment(target),
    )


def parse_iperf3_json(
    payload: dict[str, Any],
    source_label: str,
    target_label: str,
    target_host: str,
    connection_type: ConnectionType,
    *,
    direction: Direction | None = None,
    job_id: str | None = None,
    environment: DiagnosticEnvironment | None = None,
) -> BandwidthMeasurement:
    _validate_measurement_context(
        source_label,
        target_label,
        target_host,
        connection_type,
    )
    if payload.get("error"):
        raise DiagnosticCommandError(f"iperf3 error: {payload['error']}")

    end = payload.get("end")
    if not isinstance(end, dict):
        raise DiagnosticCommandError("iperf3 JSON is missing the end summary")

    summary = _first_mapping(
        end.get("sum_received"),
        end.get("sum"),
        end.get("sum_sent"),
    )
    if summary is None:
        raise DiagnosticCommandError("iperf3 JSON is missing a bandwidth summary")

    bits_per_second = _nonnegative_float(
        summary.get("bits_per_second"),
        "iperf3 bits_per_second",
    )
    jitter_value = summary.get("jitter_ms")
    jitter_ms = (
        _nonnegative_float(jitter_value, "iperf3 jitter_ms")
        if jitter_value is not None
        else None
    )
    transferred_mb = _optional_megabytes(summary.get("bytes"), "iperf3 bytes")
    measured_seconds = _optional_nonnegative_float(
        summary.get("seconds"),
        "iperf3 seconds",
    )
    sent_summary = end.get("sum_sent")
    retransmits = None
    if isinstance(sent_summary, dict) and sent_summary.get("retransmits") is not None:
        retransmits = _nonnegative_int(
            sent_summary.get("retransmits"),
            "iperf3 retransmits",
        )

    return BandwidthMeasurement(
        source_label=source_label,
        target_label=target_label,
        target_host=target_host,
        connection_type=connection_type,
        bitrate_mbps=round(bits_per_second / 1_000_000, 6),
        jitter_ms=round(jitter_ms, 6) if jitter_ms is not None else None,
        measured_at=_utc_now(),
        job_id=job_id,
        direction=direction,
        environment=environment,
        transferred_mb=transferred_mb,
        retransmits=retransmits,
        duration_seconds=(
            round(measured_seconds, 6) if measured_seconds is not None else None
        ),
    )


def parse_mtr_json(
    payload: dict[str, Any],
    source_label: str,
    target_label: str,
    target_host: str,
    connection_type: ConnectionType,
    *,
    job_id: str | None = None,
    environment: DiagnosticEnvironment | None = None,
) -> list[HopMeasurement]:
    _validate_measurement_context(
        source_label,
        target_label,
        target_host,
        connection_type,
    )
    report = payload.get("report")
    hubs = report.get("hubs") if isinstance(report, dict) else None
    if not isinstance(hubs, list) or not hubs:
        raise DiagnosticCommandError("mtr JSON is missing report.hubs")

    session_id = str(uuid.uuid4())
    measured_at = _utc_now()
    measurements: list[HopMeasurement] = []

    for fallback_number, hub in enumerate(hubs, start=1):
        if not isinstance(hub, dict):
            raise DiagnosticCommandError("mtr JSON contains an invalid hop")

        hop_number = _positive_int(hub.get("count", fallback_number), "mtr hop count")
        avg_value = hub.get("Avg")
        avg_latency_ms = (
            _nonnegative_float(avg_value, "mtr Avg") if avg_value is not None else None
        )
        loss_percent = _bounded_percentage(hub.get("Loss%"), "mtr Loss%")

        measurements.append(
            HopMeasurement(
                session_id=session_id,
                source_label=source_label,
                target_label=target_label,
                target_host=target_host,
                connection_type=connection_type,
                hop_number=hop_number,
                hop_ip=_normalize_ip(hub.get("host")),
                avg_latency_ms=(
                    round(avg_latency_ms, 6) if avg_latency_ms is not None else None
                ),
                loss_percent=round(loss_percent, 6),
                measured_at=measured_at,
                job_id=job_id,
                environment=environment,
            )
        )

    return measurements


def measurements_to_json(
    measurement: BandwidthMeasurement | list[HopMeasurement],
) -> str:
    if isinstance(measurement, list):
        value: Any = [item.as_payload() for item in measurement]
    else:
        value = measurement.as_payload()
    return json.dumps(value, indent=2, sort_keys=True)


def _run_json_command(
    binary: str,
    arguments: list[str],
    timeout_seconds: float,
) -> dict[str, Any]:
    executable = shutil.which(binary)
    if executable is None:
        raise DiagnosticCommandError(
            f"Required executable '{binary}' was not found in PATH"
        )

    try:
        result = subprocess.run(
            [executable, *arguments],
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise DiagnosticCommandError(
            f"{binary} exceeded the {timeout_seconds:g}s timeout"
        ) from exc
    except OSError as exc:
        raise DiagnosticCommandError(f"{binary} could not be started") from exc

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise DiagnosticCommandError(
            f"{binary} did not return valid JSON (exit {result.returncode})"
        ) from exc

    if not isinstance(payload, dict):
        raise DiagnosticCommandError(f"{binary} JSON root must be an object")
    if result.returncode != 0:
        detail = payload.get("error") or f"exit code {result.returncode}"
        raise DiagnosticCommandError(f"{binary} failed: {detail}")
    return payload


def _first_mapping(*values: Any) -> dict[str, Any] | None:
    return next((value for value in values if isinstance(value, dict)), None)


def _nonnegative_float(value: Any, label: str) -> float:
    try:
        converted = float(value)
    except (TypeError, ValueError) as exc:
        raise DiagnosticCommandError(f"{label} must be numeric") from exc
    if converted < 0:
        raise DiagnosticCommandError(f"{label} must be non-negative")
    return converted


def _bounded_percentage(value: Any, label: str) -> float:
    converted = _nonnegative_float(value, label)
    if converted > 100:
        raise DiagnosticCommandError(f"{label} must be between 0 and 100")
    return converted


def _positive_int(value: Any, label: str) -> int:
    try:
        converted = int(value)
    except (TypeError, ValueError) as exc:
        raise DiagnosticCommandError(f"{label} must be an integer") from exc
    if converted <= 0:
        raise DiagnosticCommandError(f"{label} must be greater than zero")
    return converted


def _nonnegative_int(value: Any, label: str) -> int:
    try:
        converted = int(value)
    except (TypeError, ValueError) as exc:
        raise DiagnosticCommandError(f"{label} must be an integer") from exc
    if converted < 0:
        raise DiagnosticCommandError(f"{label} must be non-negative")
    return converted


def _optional_nonnegative_float(value: Any, label: str) -> float | None:
    if value is None:
        return None
    return _nonnegative_float(value, label)


def _optional_megabytes(value: Any, label: str) -> float | None:
    byte_count = _optional_nonnegative_float(value, label)
    return round(byte_count / 1_000_000, 6) if byte_count is not None else None


def _normalize_ip(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(ipaddress.ip_address(value.split("%", maxsplit=1)[0]))
    except ValueError:
        return None


def _validate_measurement_context(
    source_label: str,
    target_label: str,
    target_host: str,
    connection_type: str,
) -> None:
    for label, value in (
        ("source_label", source_label),
        ("target_label", target_label),
        ("target_host", target_host),
    ):
        if not value.strip():
            raise ValueError(f"{label} is required")
    if connection_type not in VALID_CONNECTION_TYPES:
        raise ValueError("connection_type must be wifi or ethernet")


def measurement_environment(target: str) -> DiagnosticEnvironment:
    normalized = target.strip().lower()
    if normalized == "localhost":
        return "localhost_demo"
    try:
        return "localhost_demo" if ipaddress.ip_address(normalized).is_loopback else "lan"
    except ValueError:
        return "lan"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
