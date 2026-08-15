"""Durable SQLite buffer for metrics awaiting delivery."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


@dataclass(frozen=True)
class BufferedPayload:
    id: int
    payload: dict[str, Any]


class LocalBuffer:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                create table if not exists metric_buffer (
                    id integer primary key autoincrement,
                    payload text not null,
                    created_at text not null default current_timestamp
                )
                """
            )

    def enqueue(self, payload: Mapping[str, Any]) -> None:
        encoded = json.dumps(dict(payload), separators=(",", ":"), sort_keys=True)
        with self._connect() as connection:
            connection.execute(
                "insert into metric_buffer (payload) values (?)",
                (encoded,),
            )

    def pending(self, limit: int = 100) -> list[BufferedPayload]:
        with self._connect() as connection:
            rows = connection.execute(
                "select id, payload from metric_buffer order by id asc limit ?",
                (limit,),
            ).fetchall()

        return [
            BufferedPayload(id=int(row["id"]), payload=json.loads(row["payload"]))
            for row in rows
        ]

    def acknowledge(self, record_id: int) -> None:
        with self._connect() as connection:
            connection.execute("delete from metric_buffer where id = ?", (record_id,))

    def count(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "select count(*) as total from metric_buffer"
            ).fetchone()
        return int(row["total"] if row else 0)
