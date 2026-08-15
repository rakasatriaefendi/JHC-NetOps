import json
from contextlib import redirect_stdout
from io import StringIO
from subprocess import CompletedProcess
from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.diagnostics import (
    DiagnosticCommandError,
    parse_iperf3_json,
    parse_mtr_json,
    run_iperf3,
    run_mtr,
)
from network_monitoring_agent.main import main


class Iperf3DiagnosticsTest(TestCase):
    def test_parses_tcp_json_without_fabricating_jitter(self) -> None:
        result = parse_iperf3_json(
            {"end": {"sum_received": {"bits_per_second": 125_000_000}}},
            "laptop",
            "server-pusat",
            "192.0.2.10",
            "wifi",
        )

        self.assertEqual(result.bitrate_mbps, 125.0)
        self.assertIsNone(result.jitter_ms)
        self.assertEqual(result.target_host, "192.0.2.10")
        self.assertEqual(result.connection_type, "wifi")

    @patch("network_monitoring_agent.diagnostics.shutil.which", return_value="/usr/bin/iperf3")
    @patch("network_monitoring_agent.diagnostics.subprocess.run")
    def test_invokes_iperf3_with_json_flag(self, run, _which) -> None:
        run.return_value = CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {"end": {"sum": {"bits_per_second": 10_000_000, "jitter_ms": 1.5}}}
            ),
            stderr="",
        )

        run_iperf3("192.0.2.10", "laptop", "target", "wifi", port=5202)

        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/usr/bin/iperf3",
                "-c",
                "192.0.2.10",
                "-p",
                "5202",
                "-4",
                "-t",
                "10",
                "-J",
            ],
        )

    @patch("network_monitoring_agent.main._upload_bandwidth")
    @patch("network_monitoring_agent.main._run_continuous_monitor")
    @patch("network_monitoring_agent.main.run_iperf3")
    def test_cli_does_not_enter_monitor_loop(
        self,
        run_iperf,
        run_monitor,
        upload_bandwidth,
    ) -> None:
        run_iperf.return_value = parse_iperf3_json(
            {"end": {"sum_received": {"bits_per_second": 1_000_000}}},
            "laptop",
            "target",
            "192.0.2.10",
            "wifi",
        )

        with redirect_stdout(StringIO()):
            main(
                [
                    "bandwidth-test",
                    "192.0.2.10",
                    "--connection-type",
                    "wifi",
                ]
            )

        run_monitor.assert_not_called()
        upload_bandwidth.assert_called_once()

    def test_rejects_invalid_connection_type(self) -> None:
        with self.assertRaises(ValueError):
            parse_iperf3_json(
                {"end": {"sum_received": {"bits_per_second": 1_000_000}}},
                "laptop",
                "target",
                "192.0.2.10",
                "mobile",
            )


class MtrDiagnosticsTest(TestCase):
    def test_parses_hops_into_one_session(self) -> None:
        results = parse_mtr_json(
            {
                "report": {
                    "hubs": [
                        {"count": 1, "host": "192.0.2.1", "Avg": 1.2, "Loss%": 0.0},
                        {"count": 2, "host": "???", "Avg": None, "Loss%": 100.0},
                    ]
                }
            },
            "floor-7",
            "server-253",
            "192.0.2.253",
            "ethernet",
        )

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].hop_ip, "192.0.2.1")
        self.assertIsNone(results[1].hop_ip)
        self.assertEqual(results[0].session_id, results[1].session_id)
        self.assertEqual(results[0].measured_at, results[1].measured_at)
        self.assertTrue(
            all(
                hop.source_label == "floor-7"
                and hop.target_label == "server-253"
                and hop.target_host == "192.0.2.253"
                and hop.connection_type == "ethernet"
                for hop in results
            )
        )

    @patch("network_monitoring_agent.diagnostics.shutil.which", return_value="/usr/bin/mtr")
    @patch("network_monitoring_agent.diagnostics.subprocess.run")
    def test_invokes_mtr_with_json_and_five_cycles(self, run, _which) -> None:
        run.return_value = CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "report": {
                        "hubs": [
                            {
                                "count": 1,
                                "host": "192.0.2.1",
                                "Avg": 1.0,
                                "Loss%": 0.0,
                            }
                        ]
                    }
                }
            ),
            stderr="",
        )

        run_mtr(
            "198.51.100.10",
            "it-office",
            "server-253",
            "wifi",
        )

        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/usr/bin/mtr",
                "--json",
                "--no-dns",
                "-c",
                "5",
                "198.51.100.10",
            ],
        )

    def test_rejects_non_json_output(self) -> None:
        with (
            patch(
                "network_monitoring_agent.diagnostics.shutil.which",
                return_value="/usr/bin/mtr",
            ),
            patch("network_monitoring_agent.diagnostics.subprocess.run") as run,
        ):
            run.return_value = CompletedProcess(
                args=[], returncode=0, stdout="plain text", stderr=""
            )
            with self.assertRaises(DiagnosticCommandError):
                run_mtr(
                    "198.51.100.10",
                    "it-office",
                    "server-253",
                    "wifi",
                )
