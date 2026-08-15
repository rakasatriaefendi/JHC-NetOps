"""Bounded SQLite coalescing buffer for persisted flow summaries."""

from __future__ import annotations
import json
import sqlite3
from pathlib import Path


class TrafficBuffer:
    def __init__(self, path: Path, max_rows: int = 5000) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.max_rows = max_rows
        self.connection.execute("""create table if not exists traffic_flow_buffer (
          session_id text not null, flow_key text not null, payload text not null,
          updated_at text not null, primary key(session_id, flow_key))""")
        self.connection.commit()

    def put_many(self, session_id: str, rows: list[dict[str, object]]) -> None:
        self.connection.executemany(
            "insert into traffic_flow_buffer values (?, ?, ?, ?) on conflict(session_id, flow_key) do update set payload=excluded.payload, updated_at=excluded.updated_at",
            [(session_id, str(row["flow_key"]), json.dumps(row, separators=(",", ":")), str(row["last_seen"])) for row in rows],
        )
        excess = self.count() - self.max_rows
        if excess > 0:
            self.connection.execute("delete from traffic_flow_buffer where rowid in (select rowid from traffic_flow_buffer order by updated_at limit ?)", (excess,))
        self.connection.commit()

    def pending(self, session_id: str, limit: int = 100) -> list[dict[str, object]]:
        rows = self.connection.execute("select payload from traffic_flow_buffer where session_id=? order by updated_at limit ?", (session_id, limit)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def acknowledge(self, session_id: str, flow_keys: list[str]) -> None:
        self.connection.executemany("delete from traffic_flow_buffer where session_id=? and flow_key=?", [(session_id, key) for key in flow_keys])
        self.connection.commit()

    def count(self) -> int:
        return int(self.connection.execute("select count(*) from traffic_flow_buffer").fetchone()[0])

    def close(self) -> None:
        self.connection.close()
