"""Independent 10-second aggregate traffic monitoring loop."""

from __future__ import annotations

import logging
import time

from .buffer import LocalBuffer
from .config import Settings
from .network import (
    capture_snapshot,
    collect_metrics,
    discover_default_route,
    select_interface,
)
from .supabase import IngestClient


LOGGER = logging.getLogger(__name__)


def run_monitor() -> None:
    settings = Settings.from_env()
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    route = discover_default_route()
    gateway_ip = settings.gateway_ip or route.gateway_ip
    interface = select_interface(settings.network_interface, route.interface)
    buffer = LocalBuffer(settings.buffer_path)
    client = IngestClient(
        settings.supabase_url,
        settings.service_role_key,
        settings.request_timeout_seconds,
    )

    LOGGER.info("Monitoring interface: %s", interface)
    LOGGER.info("Gateway health target: %s", gateway_ip or "not detected")
    LOGGER.info("Buffered payloads waiting: %s", buffer.count())

    previous = capture_snapshot(interface)

    try:
        while True:
            time.sleep(settings.interval_seconds)
            current = capture_snapshot(interface)
            payload = collect_metrics(
                previous,
                current,
                gateway_ip,
                settings.dns_test_host,
            )
            previous = current

            if client.flush(buffer) and client.push(payload):
                LOGGER.info(
                    "Metrics sent: in=%s out=%s packets=%s gateway=%s dns=%s",
                    payload["bytes_in"],
                    payload["bytes_out"],
                    payload["packet_count"],
                    payload["gateway_reachable"],
                    payload["dns_reachable"],
                )
            else:
                buffer.enqueue(payload)
                LOGGER.warning("Metrics buffered locally; pending=%s", buffer.count())
    except KeyboardInterrupt:
        LOGGER.info("Monitoring stopped by user")

