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

            buffer.enqueue(payload)
            LOGGER.info("Metrics buffered locally; pending=%s", buffer.count())
    except KeyboardInterrupt:
        LOGGER.info("Monitoring stopped by user")

