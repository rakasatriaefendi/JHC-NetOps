import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from network_monitoring_agent.config import Settings


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

