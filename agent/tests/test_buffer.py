from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from network_monitoring_agent.buffer import LocalBuffer


class LocalBufferTest(TestCase):
    def test_payload_survives_and_can_be_acknowledged(self) -> None:
        with TemporaryDirectory() as directory:
            buffer = LocalBuffer(Path(directory) / "buffer.sqlite3")
            buffer.enqueue({"bytes_in": 42})

            records = buffer.pending()

            self.assertEqual(buffer.count(), 1)
            self.assertEqual(records[0].payload, {"bytes_in": 42})

            buffer.acknowledge(records[0].id)
            self.assertEqual(buffer.count(), 0)

