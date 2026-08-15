from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from network_monitoring_agent.traffic_buffer import TrafficBuffer


class TrafficBufferTest(TestCase):
    def test_buffer_coalesces_and_is_bounded(self):
        with TemporaryDirectory() as directory:
            buffer = TrafficBuffer(Path(directory) / "traffic.sqlite3", max_rows=2)
            row = {"flow_key":"a", "last_seen":"2026-01-01T00:00:00Z", "total_bytes":1}
            buffer.put_many("session", [row, {**row, "total_bytes":2}])
            self.assertEqual(buffer.count(), 1)
            self.assertEqual(buffer.pending("session")[0]["total_bytes"], 2)
            buffer.put_many("session", [{**row,"flow_key":"b"}, {**row,"flow_key":"c"}])
            self.assertEqual(buffer.count(), 2)
            pending = buffer.pending("session")
            buffer.acknowledge("session", [str(item["flow_key"]) for item in pending])
            self.assertEqual(buffer.count(), 0)
            buffer.close()
