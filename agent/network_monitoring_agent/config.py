"""Environment-backed configuration for the local monitoring agent."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    service_role_key: str
    network_interface: str | None
    gateway_ip: str | None
    dns_test_host: str
    interval_seconds: int
    buffer_path: Path
    request_timeout_seconds: float
    log_level: str

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()

        supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
        service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

        if not supabase_url.startswith(("http://", "https://")):
            raise ValueError("SUPABASE_URL must be a valid HTTP(S) URL")
        if not service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")

        interval_seconds = _positive_int("METRICS_INTERVAL_SECONDS", 10)
        request_timeout = _positive_float("REQUEST_TIMEOUT_SECONDS", 10.0)

        return cls(
            supabase_url=supabase_url,
            service_role_key=service_role_key,
            network_interface=_optional_env("NETWORK_INTERFACE"),
            gateway_ip=_optional_env("GATEWAY_IP"),
            dns_test_host=os.getenv("DNS_TEST_HOST", "one.one.one.one").strip()
            or "one.one.one.one",
            interval_seconds=interval_seconds,
            buffer_path=Path(
                os.getenv("LOCAL_BUFFER_PATH", "").strip()
                or "data/metrics-buffer.sqlite3"
            ).expanduser(),
            request_timeout_seconds=request_timeout,
            log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper() or "INFO",
        )


@dataclass(frozen=True)
class DiagnosticsSettings:
    supabase_url: str
    service_role_key: str
    request_timeout_seconds: float

    @classmethod
    def from_env(cls) -> "DiagnosticsSettings":
        load_dotenv()
        supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
        service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

        if not supabase_url.startswith(("http://", "https://")):
            raise ValueError("SUPABASE_URL must be a valid HTTP(S) URL")
        if not service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")

        return cls(
            supabase_url=supabase_url,
            service_role_key=service_role_key,
            request_timeout_seconds=_positive_float(
                "DIAGNOSTICS_REQUEST_TIMEOUT_SECONDS",
                30.0,
            ),
        )


@dataclass(frozen=True)
class TrafficSettings:
    supabase_url: str
    service_role_key: str
    request_timeout_seconds: float
    buffer_path: Path

    @classmethod
    def from_env(cls) -> "TrafficSettings":
        load_dotenv()
        url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url.startswith(("http://", "https://")) or not key:
            raise ValueError("Traffic backend credentials are required")
        return cls(url, key, _positive_float("TRAFFIC_REQUEST_TIMEOUT_SECONDS", 15.0),
                   Path(os.getenv("TRAFFIC_BUFFER_PATH", "data/traffic-buffer.sqlite3")).expanduser())


def _optional_env(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _positive_int(name: str, default: int) -> int:
    raw_value = os.getenv(name, str(default)).strip() or str(default)
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _positive_float(name: str, default: float) -> float:
    raw_value = os.getenv(name, str(default)).strip() or str(default)
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value
