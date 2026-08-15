"""Delivery transport dedicated to live Traffic; never touches metrics or events."""

from __future__ import annotations
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class TrafficDeliveryError(RuntimeError):
    pass


class TrafficClient:
    def __init__(self, url: str, key: str, timeout: float = 15.0) -> None:
        self.endpoint = f"{url.rstrip('/')}/functions/v1/traffic-live"
        self.timeout = timeout
        self.session = requests.Session()
        self.persistence_session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"})
        self.persistence_session.headers.update(self.session.headers)
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
        adapter = HTTPAdapter(max_retries=retry)
        self.persistence_session.mount("https://", adapter)
        self.persistence_session.mount("http://", adapter)

    def snapshot(self, runner_id: str, session_id: str, value: dict[str, object]) -> dict[str, object]:
        return self._post({"action": "update_snapshot", "runner_id": runner_id, "session_id": session_id, "snapshot": value}, retry=False)

    def flows(self, runner_id: str, session_id: str, rows: list[dict[str, object]]) -> dict[str, object]:
        return self._post({"action": "persist_flow_batch", "runner_id": runner_id, "session_id": session_id, "flows": rows}, retry=True)

    def _post(self, payload: dict[str, object], *, retry: bool) -> dict[str, object]:
        try:
            transport = self.persistence_session if retry else self.session
            response = transport.post(self.endpoint, json=payload, timeout=self.timeout)
        except requests.RequestException as exc:
            raise TrafficDeliveryError("Traffic endpoint is unreachable") from exc
        if not response.ok:
            raise TrafficDeliveryError(f"Traffic endpoint rejected data with HTTP {response.status_code}")
        data = response.json().get("data", {})
        return data if isinstance(data, dict) else {}
