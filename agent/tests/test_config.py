import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.config import Settings, TrafficSettings


class SettingsTest(TestCase):
    @patch("network_monitoring_agent.config.load_dotenv")
    def test_blank_optional_values_use_defaults(self, _load_dotenv) -> None:
        environment = {
            "PERSISTENCE_AUTHORITY": "local_postgres",
            "METRICS_INTERVAL_SECONDS": "",
            "LOCAL_BUFFER_PATH": "",
            "REQUEST_TIMEOUT_SECONDS": "",
        }

        with patch.dict(os.environ, environment, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.interval_seconds, 10)
        self.assertEqual(settings.buffer_path, Path("data/metrics-buffer.sqlite3"))
        self.assertEqual(settings.request_timeout_seconds, 10.0)

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_traffic_prefers_complete_loopback_backend_configuration(self, _load_dotenv) -> None:
        environment = {
            "PERSISTENCE_AUTHORITY": "local_postgres",
            "LOCAL_BACKEND_URL": "http://127.0.0.1:3402/",
            "LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only",
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = TrafficSettings.from_env()
        self.assertEqual(settings.backend_url, "http://127.0.0.1:3402")
        self.assertEqual(settings.backend_token, environment["LOCAL_BACKEND_TOKEN"])

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_traffic_rejects_partial_or_non_loopback_local_configuration(self, _load_dotenv) -> None:
        for environment in [
            {"LOCAL_BACKEND_URL": "http://127.0.0.1:3402"},
            {"LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only"},
            {"LOCAL_BACKEND_URL": "https://public.example", "LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only"},
        ]:
            environment["PERSISTENCE_AUTHORITY"] = "local_postgres"
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(ValueError, "Local Traffic backend configuration is invalid"):
                    TrafficSettings.from_env()

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_local_authority_requires_local_traffic_delivery(self, _load_dotenv) -> None:
        base = {
            "PERSISTENCE_AUTHORITY": "local_postgres",
        }
        with patch.dict(os.environ, base, clear=True):
            self.assertEqual(Settings.from_env().interval_seconds, 10)
            with self.assertRaisesRegex(ValueError, "Local Traffic backend configuration is required"):
                TrafficSettings.from_env()

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_invalid_persistence_authority_fails_closed(self, _load_dotenv) -> None:
        with patch.dict(os.environ, {"PERSISTENCE_AUTHORITY": "automatic"}, clear=True):
            with self.assertRaisesRegex(ValueError, "PERSISTENCE_AUTHORITY"):
                TrafficSettings.from_env()

    @patch("network_monitoring_agent.config.load_dotenv")
    def test_missing_persistence_authority_fails_closed(self, _load_dotenv) -> None:
        with patch.dict(os.environ, {
            "LOCAL_BACKEND_URL": "http://127.0.0.1:3402",
            "LOCAL_BACKEND_TOKEN": "local-runner-token-for-tests-only",
        }, clear=True):
            with self.assertRaisesRegex(ValueError, "PERSISTENCE_AUTHORITY"):
                TrafficSettings.from_env()
