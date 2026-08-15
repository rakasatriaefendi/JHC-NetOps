"""Normalized JSON-lines diagnostics for the Windows orchestration runner."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import Any, Protocol

from .diagnostics import (
    BandwidthMeasurement,
    ConnectionType,
    DiagnosticCommandError,
    DiagnosticEnvironment,
    Direction,
    HopMeasurement,
    parse_iperf3_json,
    run_mtr,
)


EmitEvent = Callable[[dict[str, Any]], None]


class DiagnosticsDelivery(Protocol):
    def push_bandwidth(self, measurement: BandwidthMeasurement) -> None: ...
    def push_hops(self, measurements: Sequence[HopMeasurement]) -> None: ...


class DiagnosticRunError(RuntimeError):
    def __init__(self, code: str, safe_message: str) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message


def run_diagnostic_suite(
    *,
    job_id: str,
    target: str,
    source_label: str,
    target_label: str,
    connection_type: ConnectionType,
    duration_seconds: int,
    port: int,
    environment: DiagnosticEnvironment,
    client: DiagnosticsDelivery,
    emit: EmitEvent,
    iperf_binary: str = "iperf3",
    mtr_binary: str = "mtr",
    mtr_count: int = 5,
) -> None:
    bandwidth: list[BandwidthMeasurement] = []
    for direction in ("upload", "download"):
        emit({"type": "stage", "stage": direction, "status": "started"})
        try:
            measurement = run_iperf3_stream(
                target,
                source_label,
                target_label,
                connection_type,
                direction=direction,
                duration_seconds=duration_seconds,
                port=port,
                environment=environment,
                job_id=job_id,
                emit=emit,
                binary=iperf_binary,
                start_local_server=environment == "localhost_demo",
            )
        except DiagnosticCommandError as exc:
            code = "UPLOAD_FAILED" if direction == "upload" else "DOWNLOAD_FAILED"
            raise DiagnosticRunError(code, f"{direction.title()} measurement failed") from exc
        bandwidth.append(measurement)
        emit(
            {
                "type": "summary",
                "direction": direction,
                "average_mbps": measurement.bitrate_mbps,
                "peak_mbps": measurement.peak_mbps,
                "minimum_mbps": measurement.minimum_mbps,
                "transferred_mb": measurement.transferred_mb,
                "retransmits": measurement.retransmits,
                "duration_seconds": measurement.duration_seconds,
            }
        )

    emit({"type": "stage", "stage": "mtr", "status": "started"})
    try:
        hops = run_mtr(
            target,
            source_label,
            target_label,
            connection_type,
            count=mtr_count,
            binary=mtr_binary,
            job_id=job_id,
            environment=environment,
        )
    except DiagnosticCommandError as exc:
        raise DiagnosticRunError("MTR_FAILED", "Path diagnostic failed") from exc

    emit({"type": "stage", "stage": "saving", "status": "started"})
    try:
        for measurement in bandwidth:
            client.push_bandwidth(measurement)
        client.push_hops(hops)
    except Exception as exc:
        raise DiagnosticRunError(
            "BACKEND_UPLOAD_FAILED",
            "Diagnostic results could not be saved",
        ) from exc

    emit(
        {
            "type": "complete",
            "job_id": job_id,
            "bandwidth_directions": [item.direction for item in bandwidth],
            "hop_count": len(hops),
        }
    )


def run_iperf3_stream(
    target: str,
    source_label: str,
    target_label: str,
    connection_type: ConnectionType,
    *,
    direction: Direction,
    duration_seconds: int,
    port: int,
    environment: DiagnosticEnvironment,
    job_id: str,
    emit: EmitEvent,
    binary: str = "iperf3",
    start_local_server: bool = False,
) -> BandwidthMeasurement:
    executable = shutil.which(binary)
    if executable is None:
        raise DiagnosticCommandError(f"Required executable '{binary}' was not found in PATH")

    server: subprocess.Popen[str] | None = None
    process: subprocess.Popen[str] | None = None
    try:
        if start_local_server:
            server = _start_owned_local_server(executable, target, port)

        command = [
            executable,
            "-c",
            target,
            "-p",
            str(port),
            "-4",
            "-t",
            str(duration_seconds),
            "-i",
            "1",
            "--json-stream",
            "--forceflush",
        ]
        if direction == "download":
            command.append("-R")

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if process.stdout is None:
            process.kill()
            raise DiagnosticCommandError("iperf3 stdout could not be captured")

        samples: list[dict[str, float]] = []
        cumulative_bytes = 0.0
        elapsed_seconds = 0.0
        end_payload: dict[str, Any] | None = None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                process.kill()
                raise DiagnosticCommandError("iperf3 stream returned invalid JSON") from exc
            if not isinstance(event, dict):
                continue
            event_type = event.get("event")
            data = event.get("data")
            if event_type == "interval" and isinstance(data, dict):
                interval = _parse_interval(data)
                cumulative_bytes += interval["bytes"]
                elapsed_seconds = max(elapsed_seconds, interval["end"])
                mbps = interval["mbps"]
                samples.append({"second": round(elapsed_seconds, 3), "mbps": mbps})
                average_mbps = (
                    cumulative_bytes * 8 / elapsed_seconds / 1_000_000
                    if elapsed_seconds > 0
                    else 0.0
                )
                emit(
                    {
                        "type": "interval",
                        "direction": direction,
                        "second": round(elapsed_seconds, 3),
                        "mbps": round(mbps, 6),
                        "average_mbps": round(average_mbps, 6),
                        "peak_mbps": round(max(item["mbps"] for item in samples), 6),
                        "minimum_mbps": round(min(item["mbps"] for item in samples), 6),
                        "transferred_mb": round(cumulative_bytes / 1_000_000, 6),
                        "retransmits": interval["retransmits"],
                    }
                )
            elif event_type == "end" and isinstance(data, dict):
                end_payload = data

        return_code = process.wait()
        if return_code != 0 or end_payload is None:
            raise DiagnosticCommandError(f"iperf3 stream failed with exit code {return_code}")

        measurement = parse_iperf3_json(
            {"end": end_payload},
            source_label,
            target_label,
            target,
            connection_type,
            direction=direction,
            job_id=job_id,
            environment=environment,
        )
        if samples:
            measurement = replace(
                measurement,
                peak_mbps=round(max(item["mbps"] for item in samples), 6),
                minimum_mbps=round(min(item["mbps"] for item in samples), 6),
            )
        return measurement
    finally:
        _stop_owned_process(process)
        _stop_owned_process(server)


def _parse_interval(data: dict[str, Any]) -> dict[str, float | int | None]:
    summary = data.get("sum")
    if not isinstance(summary, dict):
        raise DiagnosticCommandError("iperf3 interval is missing data.sum")
    try:
        bits_per_second = float(summary["bits_per_second"])
        byte_count = float(summary["bytes"])
        end = float(summary["end"])
    except (KeyError, TypeError, ValueError) as exc:
        raise DiagnosticCommandError("iperf3 interval contains invalid numbers") from exc
    if bits_per_second < 0 or byte_count < 0 or end < 0:
        raise DiagnosticCommandError("iperf3 interval values must be non-negative")
    retransmits_value = summary.get("retransmits")
    try:
        retransmits = int(retransmits_value) if retransmits_value is not None else None
    except (TypeError, ValueError) as exc:
        raise DiagnosticCommandError("iperf3 interval retransmits must be an integer") from exc
    if retransmits is not None and retransmits < 0:
        raise DiagnosticCommandError("iperf3 interval retransmits must be non-negative")
    return {
        "mbps": bits_per_second / 1_000_000,
        "bytes": byte_count,
        "end": end,
        "retransmits": retransmits,
    }


def _start_owned_local_server(
    executable: str,
    bind_host: str,
    port: int,
) -> subprocess.Popen[str]:
    server = subprocess.Popen(
        [executable, "-s", "-4", "-B", bind_host, "-p", str(port), "-1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(0.25)
    if server.poll() is not None:
        raise DiagnosticCommandError("Temporary localhost iperf3 server could not start")
    return server


def _stop_owned_process(process: subprocess.Popen[str] | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
    for stream in (process.stdin, process.stdout, process.stderr):
        close = getattr(stream, "close", None)
        if close is not None:
            close()
