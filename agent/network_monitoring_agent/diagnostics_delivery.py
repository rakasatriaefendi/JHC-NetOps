"""Delivery client dedicated to on-demand diagnostics measurements."""

from __future__ import annotations

from collections.abc import Sequence

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .diagnostics import BandwidthMeasurement, HopMeasurement


class DiagnosticDeliveryError(RuntimeError):
    """Raised when a diagnostic measurement cannot be stored."""


class DiagnosticsClient:
    def __init__(
        self,
        supabase_url: str,
        service_role_key: str,
        timeout_seconds: float,
    ) -> None:
        self.endpoint = f"{supabase_url.rstrip('/')}/functions/v1/diagnostics"
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
            total=2,
            connect=2,
            read=2,
            status=2,
            backoff_factor=1,
            status_forcelist=(408, 429, 500, 502, 503, 504),
            allowed_methods=frozenset({"POST"}),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    def push_bandwidth(self, measurement: BandwidthMeasurement) -> None:
        self._post(
            {
                "type": "bandwidth",
                "measurement": measurement.as_payload(),
            }
        )

    def push_hops(self, measurements: Sequence[HopMeasurement]) -> None:
        if not measurements:
            raise DiagnosticDeliveryError("Cannot upload an empty hop measurement")
        self._post(
            {
                "type": "hops",
                "measurements": [item.as_payload() for item in measurements],
            }
        )

    def _post(self, payload: dict[str, object]) -> None:
        try:
            response = self.session.post(
                self.endpoint,
                json=payload,
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as exc:
            raise DiagnosticDeliveryError(
                f"Diagnostics endpoint is unreachable ({exc.__class__.__name__})"
            ) from exc

        if not 200 <= response.status_code < 300:
            raise DiagnosticDeliveryError(
                f"Diagnostics endpoint rejected data with HTTP {response.status_code}"
            )

