from unittest import TestCase
from unittest.mock import Mock, patch

import requests

from network_monitoring_agent.traffic_delivery import TrafficClient, TrafficDeliveryError


class TrafficDeliveryTest(TestCase):
    def test_transport_uses_bounded_exponential_retry(self):
        client = TrafficClient("https://example.supabase.co", "service-key")
        retry = client.persistence_session.get_adapter("https://").max_retries
        self.assertEqual(retry.total, 3)
        self.assertEqual(retry.backoff_factor, 1)
        self.assertIn(503, retry.status_forcelist)
        self.assertEqual(retry.allowed_methods, frozenset({"POST"}))
        self.assertEqual(client.session.get_adapter("https://").max_retries.total, 0)

    def test_backend_outage_raises_safe_error(self):
        client = TrafficClient("https://example.supabase.co", "service-key")
        client.session.post = Mock(side_effect=requests.ConnectionError("private detail"))
        with self.assertRaisesRegex(TrafficDeliveryError, "unreachable"):
            client.snapshot("runner", "session", {})

    def test_success_returns_only_structured_data(self):
        response = Mock(ok=True)
        response.json.return_value = {"data": {"stop_requested": True}, "ignored": "raw"}
        client = TrafficClient("https://example.supabase.co", "service-key")
        client.session.post = Mock(return_value=response)
        self.assertEqual(client.snapshot("runner", "session", {}), {"stop_requested": True})

    def test_local_backend_uses_runner_route_without_supabase_api_key(self):
        client = TrafficClient(
            "http://127.0.0.1:3402",
            "local-runner-token-for-tests-only",
            local_backend=True,
        )
        self.assertEqual(client.endpoint, "http://127.0.0.1:3402/api/runner/traffic")
        self.assertNotIn("apikey", client.session.headers)
        self.assertEqual(
            client.session.headers["Authorization"],
            "Bearer local-runner-token-for-tests-only",
        )
