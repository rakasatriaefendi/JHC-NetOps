import os
from unittest import TestCase, skipUnless

from network_monitoring_agent.streaming import run_iperf3_stream


@skipUnless(
    os.getenv("RUN_LIVE_DIAGNOSTICS") == "1",
    "controlled localhost integration test is opt-in",
)
class LocalhostStreamingIntegrationTest(TestCase):
    def test_owned_server_and_streaming_client(self) -> None:
        events: list[dict[str, object]] = []
        result = run_iperf3_stream(
            "127.0.0.1",
            "Local Development",
            "Localhost — TEST ENVIRONMENT",
            "wifi",
            direction="upload",
            duration_seconds=2,
            port=int(os.getenv("LIVE_IPERF_PORT", "5202")),
            environment="localhost_demo",
            job_id="2f3f15bf-aee7-4999-82a2-8e69569946b7",
            emit=events.append,
            binary="/usr/local/bin/iperf3",
            start_local_server=True,
        )
        self.assertGreater(result.bitrate_mbps, 0)
        self.assertTrue(any(event["type"] == "interval" for event in events))
