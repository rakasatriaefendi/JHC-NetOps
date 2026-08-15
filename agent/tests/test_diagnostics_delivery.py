from unittest import TestCase
from unittest.mock import Mock

from network_monitoring_agent.diagnostics import BandwidthMeasurement, HopMeasurement
from network_monitoring_agent.diagnostics_delivery import DiagnosticsClient


class DiagnosticsClientTest(TestCase):
    def setUp(self) -> None:
        self.client = DiagnosticsClient(
            "https://example.supabase.co",
            "service-role-test",
            15.0,
        )
        self.client.session.post = Mock(return_value=Mock(status_code=201))

    def test_bandwidth_uses_separate_diagnostics_endpoint(self) -> None:
        measurement = BandwidthMeasurement(
            source_label="laptop",
            target_label="server",
            target_host="192.0.2.10",
            connection_type="wifi",
            bitrate_mbps=100.0,
            jitter_ms=None,
            measured_at="2026-08-11T00:00:00+00:00",
        )

        self.client.push_bandwidth(measurement)

        call = self.client.session.post.call_args
        self.assertEqual(
            call.args[0],
            "https://example.supabase.co/functions/v1/diagnostics",
        )
        self.assertEqual(call.kwargs["json"]["type"], "bandwidth")
        self.assertEqual(
            call.kwargs["json"]["measurement"]["connection_type"],
            "wifi",
        )
        self.assertEqual(
            call.kwargs["json"]["measurement"]["target_host"],
            "192.0.2.10",
        )

    def test_hops_are_sent_as_one_session_batch(self) -> None:
        hops = [
            HopMeasurement(
                session_id="00000000-0000-4000-8000-000000000001",
                source_label="floor-7",
                target_label="server-253",
                target_host="192.0.2.253",
                connection_type="ethernet",
                hop_number=1,
                hop_ip="192.0.2.1",
                avg_latency_ms=1.0,
                loss_percent=0.0,
                measured_at="2026-08-11T00:00:00+00:00",
            )
        ]

        self.client.push_hops(hops)

        call = self.client.session.post.call_args
        self.assertEqual(call.kwargs["json"]["type"], "hops")
        self.assertEqual(len(call.kwargs["json"]["measurements"]), 1)
        self.assertEqual(
            call.kwargs["json"]["measurements"][0]["connection_type"],
            "ethernet",
        )
