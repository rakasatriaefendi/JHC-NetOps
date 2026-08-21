"""Bounded, non-secret lifecycle tracing for Device Inspector diagnostics."""

from __future__ import annotations

import json
import re
import sys
import time
from collections.abc import Callable
from typing import Any, TextIO

TRACE_PREFIX = "INSPECTION_TRACE "
MAX_TRACE_RECORDS = 128
MAX_TRACE_LINE_BYTES = 512

TRACE_PHASES = frozenset({
    "cli_entry",
    "inspect_device_entry",
    "tcp_phase_start",
    "tcp_phase_end",
    "collector_start",
    "collector_end",
    "normalization_start",
    "normalization_end",
    "partial_finalize_start",
    "partial_finalize_end",
    "json_serialize_start",
    "json_serialize_end",
    "stdout_write",
    "cli_return",
    "child_created",
    "terminate_requested",
    "kill_requested",
    "child_exit_observed",
})
TRACE_STATUSES = frozenset({
    "completed",
    "timeout",
    "skipped_budget",
    "failed",
    "exited",
})
_COLLECTOR_NAME = re.compile(r"^[a-z][a-z0-9_:-]{0,39}$")


class InspectionTrace:
    """Emit only allow-listed timing fields; never accept probe content."""

    def __init__(
        self,
        stream: TextIO | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        origin: float | None = None,
    ) -> None:
        self._stream = stream or sys.stderr
        self._monotonic = monotonic
        self._origin = monotonic() if origin is None else origin
        self._records = 0

    def emit(self, phase: str, **fields: Any) -> None:
        if self._records >= MAX_TRACE_RECORDS or phase not in TRACE_PHASES:
            return
        record: dict[str, Any] = {
            "phase": phase,
            "elapsed_ms": self._milliseconds(self._monotonic() - self._origin),
        }
        collector_name = fields.get("collector_name")
        if isinstance(collector_name, str) and _COLLECTOR_NAME.fullmatch(collector_name):
            record["collector_name"] = collector_name
        status = fields.get("status")
        if status in TRACE_STATUSES:
            record["status"] = status
        for name in ("remaining_budget_ms", "duration_ms"):
            value = fields.get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                record[name] = self._milliseconds(float(value) / 1000)
        for name in ("child_pid", "process_group_id", "exit_code"):
            value = fields.get(name)
            if isinstance(value, int) and not isinstance(value, bool) and -1 <= value <= 2_147_483_647:
                record[name] = value
        encoded = json.dumps(record, separators=(",", ":"), sort_keys=True)
        line = f"{TRACE_PREFIX}{encoded}"
        if len(line.encode("utf-8")) > MAX_TRACE_LINE_BYTES:
            return
        self._records += 1
        self._stream.write(f"{line}\n")
        self._stream.flush()

    @staticmethod
    def _milliseconds(seconds: float) -> int:
        return max(0, min(120_000, round(seconds * 1000)))
