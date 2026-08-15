"""Supabase Edge Function delivery with retries and buffered replay."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .buffer import LocalBuffer


LOGGER = logging.getLogger(__name__)


class IngestClient:
    def __init__(
        self,
        supabase_url: str,
        service_role_key: str,
        timeout_seconds: float,
    ) -> None:
        self.endpoint = f"{supabase_url.rstrip('/')}/functions/v1/ingest"
        self.timeout_seconds = timeout_seconds
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {service_role_key}",
                "apikey": service_role_key,
                "Content-Type": "application/json",
            }
        )
        retry = Retry(
            total=3,
            connect=3,
            read=3,
            status=3,
            backoff_factor=1,
            status_forcelist=(408, 429, 500, 502, 503, 504),
            allowed_methods=frozenset({"POST"}),
            raise_on_status=False,
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.session.mount("http://", HTTPAdapter(max_retries=retry))

    def push(self, payload: Mapping[str, Any]) -> bool:
        try:
            response = self.session.post(
                self.endpoint,
                json=dict(payload),
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as exc:
            LOGGER.warning("Metrics delivery failed: %s", exc.__class__.__name__)
            return False

        if 200 <= response.status_code < 300:
            return True

        LOGGER.warning("Metrics delivery rejected with HTTP %s", response.status_code)
        return False

    def flush(self, buffer: LocalBuffer) -> bool:
        for record in buffer.pending():
            if not self.push(record.payload):
                return False
            buffer.acknowledge(record.id)
        return True

