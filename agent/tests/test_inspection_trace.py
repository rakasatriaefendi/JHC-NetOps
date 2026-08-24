import json
import multiprocessing
import time
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.device_inspector import inspect_device
from network_monitoring_agent.inspection_trace import (
    MAX_TRACE_LINE_BYTES,
    MAX_TRACE_RECORDS,
    TRACE_PREFIX,
    InspectionTrace,
)
from network_monitoring_agent.main import main


def _records(stream: StringIO) -> list[dict[str, object]]:
    return [
        json.loads(line.removeprefix(TRACE_PREFIX))
        for line in stream.getvalue().splitlines()
        if line.startswith(TRACE_PREFIX)
    ]


def _context() -> dict[str, object]:
    return {
        "route_role": "on_link",
        "same_subnet": True,
        "mac": None,
        "reachable": True,
        "is_this_device": False,
        "interface_index": 20,
        "interface_alias": "Wi-Fi",
        "interface_description": "Adapter",
        "interface_type": "physical",
    }


class InspectionTraceTest(TestCase):
    def test_trace_is_bounded_allowlisted_and_drops_secret_fields(self) -> None:
        stream = StringIO()
        trace = InspectionTrace(stream)
        for index in range(MAX_TRACE_RECORDS + 20):
            trace.emit(
                "collector_start",
                collector_name="upnp",
                remaining_budget_ms=index,
                payload="raw-secret-body",
                authorization="Bearer secret-token",
            )
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), MAX_TRACE_RECORDS)
        self.assertTrue(all(len(line.encode("utf-8")) <= MAX_TRACE_LINE_BYTES for line in lines))
        serialized = stream.getvalue().lower()
        for prohibited in ("raw-secret-body", "secret-token", "payload", "authorization"):
            self.assertNotIn(prohibited, serialized)

    @patch("network_monitoring_agent.device_inspector.upnp_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_trace_does_not_change_normalized_schema(self, *_mocks) -> None:
        without_trace = inspect_device("192.168.188.20", _context())
        stream = StringIO()
        with_trace = inspect_device("192.168.188.20", _context(), trace=InspectionTrace(stream))
        self.assertEqual(with_trace, without_trace)
        self.assertNotIn("trace", json.dumps(with_trace).lower())
        phases = [record["phase"] for record in _records(stream)]
        self.assertIn("partial_finalize_end", phases)
        self.assertIn("normalization_end", phases)

    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_hanging_collector_records_timeout_termination_and_exit(self, _tcp) -> None:
        def never_returns(*_args, **_kwargs):
            time.sleep(60)

        stream = StringIO()
        before = {child.pid for child in multiprocessing.active_children()}
        with patch("network_monitoring_agent.device_inspector.upnp_metadata", side_effect=never_returns):
            started = time.monotonic()
            result = inspect_device(
                "192.168.188.20",
                _context(),
                total_budget_seconds=1.0,
                trace=InspectionTrace(stream),
            )
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertTrue(result["probe_summary"]["partial"])
        records = _records(stream)
        self.assertTrue(any(
            record.get("phase") == "collector_end" and
            record.get("collector_name") == "upnp" and
            record.get("status") == "timeout"
            for record in records
        ))
        self.assertTrue(any(
            record.get("phase") == "terminate_requested" and record.get("collector_name") == "upnp"
            for record in records
        ))
        child_records = [record for record in records if record.get("phase") == "child_created"]
        self.assertTrue(child_records)
        self.assertTrue(all(isinstance(record.get("child_pid"), int) for record in child_records))
        self.assertTrue(any(
            record.get("phase") == "child_exit_observed" and record.get("collector_name") == "upnp"
            for record in records
        ))
        time.sleep(0.05)
        self.assertEqual({child.pid for child in multiprocessing.active_children()} - before, set())

    @patch("network_monitoring_agent.device_inspector.upnp_metadata", return_value=None)
    @patch("network_monitoring_agent.device_inspector.probe_tcp_service_states", return_value=[])
    def test_cli_startup_finalization_serialization_and_flush_are_distinct(self, *_mocks) -> None:
        stdout = StringIO()
        stderr = StringIO()
        args = [
            "device-inspect", "192.168.188.20", "--route-role", "on_link",
            "--same-subnet", "yes", "--reachable", "yes",
            "--is-this-device", "no", "--interface-index", "20",
            "--interface-alias", "Wi-Fi", "--interface-description", "Adapter",
            "--interface-type", "physical",
        ]
        with redirect_stdout(stdout), redirect_stderr(stderr):
            main(args)

        stdout_lines = stdout.getvalue().splitlines()
        self.assertTrue(stdout_lines)
        self.assertTrue(all(not line.startswith(TRACE_PREFIX) for line in stdout_lines))
        self.assertTrue(all(isinstance(json.loads(line), dict) for line in stdout_lines))
        records = _records(stderr)
        phases = [record["phase"] for record in records]
        self.assertLess(phases.index("cli_entry"), phases.index("inspect_device_entry"))
        for phase in (
            "partial_finalize_start", "partial_finalize_end", "normalization_start",
            "normalization_end", "json_serialize_start", "json_serialize_end",
            "stdout_write", "cli_return",
        ):
            self.assertIn(phase, phases)
