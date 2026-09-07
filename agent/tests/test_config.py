import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.config import Settings, TrafficSettings


class SettingsTest(TestCase):
    @patch("network_monitoring_agent.config.load_dotenv")
    def test_blank_optional_values_use_defaults(self, _load_dotenv) -> None:
        environment = {
            "SUPABASE_URL": "https://example.supabase.co/",
            "SUPABASE_SERVICE_ROLE_KEY": "test-secret",
            "METRICS_INTERVAL_SECONDS": "",
            "LOCAL_BUFFER_PATH": "",
            "REQUEST_TIMEOUT_SECONDS": "",
        }

        with patch.dict(os.environ, environment, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.supabase_url, "https://example.supabase.co")
        self.assertEqual(settings.interval_seconds, 10)
        self.assertEqual(settings.buffer_path, Path("data/metrics-buffer.sqlite3"))
        self.assertEqual(settings.request_timeout_seconds, 10.0)

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_traffic_prefers_complete_loopback_backend_configuration(self, _load_dotenv) -> None:
        environment = {
            "LOCAL_BACKEND_URL": "http://127.0.0.1:3402/",
            "LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only",
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-key",
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = TrafficSettings.from_env()
        self.assertEqual(settings.backend_url, "http://127.0.0.1:3402")
        self.assertTrue(settings.local_backend)
        self.assertEqual(settings.backend_token, environment["LOCAL_BACKEND_TOKEN"])

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_traffic_rejects_partial_or_non_loopback_local_configuration(self, _load_dotenv) -> None:
        for environment in [
            {"LOCAL_BACKEND_URL": "http://127.0.0.1:3402"},
            {"LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only"},
            {"LOCAL_BACKEND_URL": "https://public.example", "LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only"},
        ]:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(ValueError, "Local Traffic backend configuration is invalid"):
                    TrafficSettings.from_env()
