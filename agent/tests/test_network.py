from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.network import CounterSnapshot, collect_metrics


class CollectMetricsTest(TestCase):
    @patch("network_monitoring_agent.network.resolve_dns", return_value=True)
    @patch("network_monitoring_agent.network.ping_target", return_value=(True, 4.25))
    def test_collects_counter_deltas(self, _ping, _dns) -> None:
        previous = CounterSnapshot(10.0, 100, 200, 5, 7)
        current = CounterSnapshot(20.0, 500, 350, 11, 14)

        metrics = collect_metrics(previous, current, "192.0.2.1", "example.test")

        self.assertEqual(metrics["interval_seconds"], 10)
        self.assertEqual(metrics["bytes_in"], 400)
        self.assertEqual(metrics["bytes_out"], 150)
        self.assertEqual(metrics["packet_count"], 13)
        self.assertEqual(metrics["avg_latency_ms"], 4.25)
        self.assertEqual(metrics["packet_loss_pct"], 0.0)
        self.assertTrue(metrics["gateway_reachable"])
        self.assertTrue(metrics["dns_reachable"])

    @patch("network_monitoring_agent.network.resolve_dns", return_value=False)
    @patch("network_monitoring_agent.network.ping_target", return_value=(False, None))
    def test_reports_failed_health_checks(self, _ping, _dns) -> None:
        previous = CounterSnapshot(10.0, 500, 500, 10, 10)
        current = CounterSnapshot(20.0, 100, 100, 2, 2)

        metrics = collect_metrics(previous, current, None, "example.test")

        self.assertEqual(metrics["bytes_in"], 0)
        self.assertEqual(metrics["bytes_out"], 0)
        self.assertEqual(metrics["packet_loss_pct"], 100.0)
        self.assertFalse(metrics["gateway_reachable"])
        self.assertFalse(metrics["dns_reachable"])

