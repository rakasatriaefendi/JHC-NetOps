import json
from subprocess import TimeoutExpired
from unittest import TestCase
from unittest.mock import Mock, call, patch

from network_monitoring_agent.diagnostics import DiagnosticCommandError, parse_mtr_json
from network_monitoring_agent.streaming import (
    DiagnosticRunError,
    _parse_interval,
    _stop_owned_process,
    run_diagnostic_suite,
    run_iperf3_stream,
)


def _stream_lines() -> list[str]:
    return [
        json.dumps(
            {
                "event": "interval",
                "data": {
                    "sum": {
                        "bits_per_second": 40_000_000,
                        "bytes": 5_000_000,
                        "end": 1.0,
                        "retransmits": 1,
                    }
                },
            }
        ),
        json.dumps(
            {
                "event": "interval",
                "data": {
                    "sum": {
                        "bits_per_second": 56_000_000,
                        "bytes": 7_000_000,
                        "end": 2.0,
                        "retransmits": 0,
                    }
                },
            }
        ),
        json.dumps(
            {
                "event": "end",
                "data": {
                    "sum_received": {
                        "bits_per_second": 48_000_000,
                        "bytes": 12_000_000,
                        "seconds": 2.0,
                    },
                    "sum_sent": {
                        "bits_per_second": 49_000_000,
                        "bytes": 12_250_000,
                        "seconds": 2.0,
                        "retransmits": 1,
                    },
                },
            }
        ),
    ]


class StreamingIperfTest(TestCase):
    @patch("network_monitoring_agent.streaming.shutil.which", return_value="/usr/local/bin/iperf3")
    @patch("network_monitoring_agent.streaming.subprocess.Popen")
    def test_upload_stream_emits_normalized_events_and_receiver_summary(
        self, popen, _which
    ) -> None:
        process = Mock()
        process.stdout = iter(_stream_lines())
        process.wait.return_value = 0
        process.poll.return_value = 0
        popen.return_value = process
        events: list[dict[str, object]] = []

        result = run_iperf3_stream(
            "192.0.2.10",
            "IT Office",
            "Server 253",
            "wifi",
            direction="upload",
            duration_seconds=5,
            port=5201,
            environment="lan",
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
            emit=events.append,
        )

        command = popen.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/usr/local/bin/iperf3",
                "-c",
                "192.0.2.10",
                "-p",
                "5201",
                "-4",
                "-t",
                "5",
                "-i",
                "1",
                "--json-stream",
                "--forceflush",
            ],
        )
        self.assertEqual(result.bitrate_mbps, 48.0)
        self.assertEqual(result.peak_mbps, 56.0)
        self.assertEqual(result.minimum_mbps, 40.0)
        self.assertEqual(result.transferred_mb, 12.0)
        self.assertEqual(result.retransmits, 1)
        self.assertEqual(result.direction, "upload")
        self.assertEqual(events[-1]["average_mbps"], 48.0)
        self.assertNotIn("raw", events[-1])

    @patch("network_monitoring_agent.streaming.shutil.which", return_value="/usr/local/bin/iperf3")
    @patch("network_monitoring_agent.streaming.subprocess.Popen")
    def test_download_adds_reverse_flag_and_does_not_fabricate_retransmits(
        self, popen, _which
    ) -> None:
        lines = _stream_lines()
        end_event = json.loads(lines[-1])
        end_event["data"]["sum_sent"].pop("retransmits")
        process = Mock()
        process.stdout = iter([*lines[:-1], json.dumps(end_event)])
        process.wait.return_value = 0
        process.poll.return_value = 0
        popen.return_value = process

        result = run_iperf3_stream(
            "192.0.2.10",
            "IT Office",
            "Server 253",
            "ethernet",
            direction="download",
            duration_seconds=5,
            port=5201,
            environment="lan",
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
            emit=lambda _: None,
        )

        self.assertEqual(popen.call_args.args[0][-1], "-R")
        self.assertIsNone(result.retransmits)

    def test_rejects_invalid_interval_values(self) -> None:
        with self.assertRaises(DiagnosticCommandError):
            _parse_interval(
                {
                    "sum": {
                        "bits_per_second": 1,
                        "bytes": 1,
                        "end": 1,
                        "retransmits": -1,
                    }
                }
            )

    def test_owned_process_cleanup_only_targets_passed_process(self) -> None:
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [TimeoutExpired("iperf3", 2), 0]

        _stop_owned_process(process)

        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)


class DiagnosticSuiteTest(TestCase):
    @patch("network_monitoring_agent.streaming.run_mtr")
    @patch("network_monitoring_agent.streaming.run_iperf3_stream")
    def test_suite_runs_both_directions_mtr_and_delivery(self, run_iperf, run_mtr) -> None:
        from network_monitoring_agent.diagnostics import BandwidthMeasurement

        upload = BandwidthMeasurement(
            "IT Office", "Server", "127.0.0.1", "wifi", 50, None, "2026-01-01T00:00:00Z",
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec", direction="upload",
            environment="localhost_demo",
        )
        download = BandwidthMeasurement(
            "IT Office", "Server", "127.0.0.1", "wifi", 60, None, "2026-01-01T00:00:01Z",
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec", direction="download",
            environment="localhost_demo",
        )
        run_iperf.side_effect = [upload, download]
        hops = parse_mtr_json(
            {"report": {"hubs": [{"count": 1, "host": "127.0.0.1", "Avg": 0.1, "Loss%": 0}] }},
            "IT Office", "Server", "127.0.0.1", "wifi",
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec", environment="localhost_demo",
        )
        run_mtr.return_value = hops
        client = Mock()
        events: list[dict[str, object]] = []

        run_diagnostic_suite(
            job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
            target="127.0.0.1",
            source_label="IT Office",
            target_label="Localhost",
            connection_type="wifi",
            duration_seconds=5,
            port=5201,
            environment="localhost_demo",
            client=client,
            emit=events.append,
        )

        self.assertEqual(
            [item.kwargs["direction"] for item in run_iperf.call_args_list],
            ["upload", "download"],
        )
        self.assertEqual(client.push_bandwidth.call_args_list, [call(upload), call(download)])
        client.push_hops.assert_called_once_with(hops)
        self.assertEqual(events[-1]["type"], "complete")

    @patch("network_monitoring_agent.streaming.run_iperf3_stream")
    def test_suite_exposes_only_safe_error(self, run_iperf) -> None:
        run_iperf.side_effect = DiagnosticCommandError("sensitive raw stderr")

        with self.assertRaises(DiagnosticRunError) as raised:
            run_diagnostic_suite(
                job_id="8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
                target="127.0.0.1",
                source_label="IT Office",
                target_label="Localhost",
                connection_type="wifi",
                duration_seconds=5,
                port=5201,
                environment="localhost_demo",
                client=Mock(),
                emit=lambda _: None,
            )

        self.assertEqual(raised.exception.code, "UPLOAD_FAILED")
        self.assertNotIn("sensitive", raised.exception.safe_message)
