"""Entry point for the portable basic network monitoring agent."""

from __future__ import annotations

import argparse
import json
import socket
from collections.abc import Sequence

from .diagnostics import (
    DiagnosticCommandError,
    measurements_to_json,
    run_iperf3,
    run_mtr,
)
from .diagnostics_delivery import DiagnosticDeliveryError
from .streaming import DiagnosticRunError, run_diagnostic_suite


def main(argv: Sequence[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "capabilities":
            from .device_inspector import inspector_capabilities
            print(json.dumps(inspector_capabilities(), separators=(",", ":")))
            return
        if args.command == "bandwidth-test":
            measurement = run_iperf3(
                args.target,
                args.source_label,
                args.target_label or args.target,
                args.connection_type,
                port=args.port,
                timeout_seconds=args.timeout,
                binary=args.binary,
            )
            if not args.no_upload:
                _upload_bandwidth(measurement)
            print(measurements_to_json(measurement))
            return

        if args.command == "path-test":
            measurements = run_mtr(
                args.target,
                args.source_label,
                args.target_label or args.target,
                args.connection_type,
                count=args.count,
                timeout_seconds=args.timeout,
                binary=args.binary,
            )
            if not args.no_upload:
                _upload_hops(measurements)
            print(measurements_to_json(measurements))
            return

        if args.command == "diagnostic-run":
            _run_diagnostic_job(args)
            return
        if args.command == "traffic-live":
            _run_traffic_live(args)
            return
        if args.command == "traffic-interface-check":
            from .traffic_live import resolve_capture_interface
            print(resolve_capture_interface(args.interface))
            return
        if args.command == "device-inspect":
            _run_device_inspection(args)
            return
    except (DiagnosticCommandError, DiagnosticDeliveryError, ValueError) as exc:
        parser.exit(2, f"diagnostic failed: {exc}\n")

    _run_continuous_monitor()


def _run_continuous_monitor() -> None:
    from .monitor import run_monitor

    run_monitor()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="network-monitor",
        description="Network monitoring agent and on-demand diagnostics",
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser(
        "monitor",
        help="run the independent 10-second aggregate metrics loop",
    )
    subparsers.add_parser(
        "capabilities",
        help="print normalized local agent capabilities without changing state",
    )

    bandwidth = subparsers.add_parser(
        "bandwidth-test",
        help="run one on-demand iperf3 JSON measurement",
    )
    bandwidth.add_argument("target", help="iperf3 server hostname or IP")
    bandwidth.add_argument(
        "--source-label",
        default=socket.gethostname(),
        help="human-readable source label",
    )
    bandwidth.add_argument(
        "--target-label",
        help="human-readable target label (defaults to target)",
    )
    bandwidth.add_argument(
        "--connection-type",
        required=True,
        choices=("wifi", "ethernet"),
        help="explicit client transport; never inferred from the WSL interface",
    )
    bandwidth.add_argument("--port", type=int, default=5201)
    bandwidth.add_argument("--timeout", type=float, default=45.0)
    bandwidth.add_argument(
        "--no-upload",
        action="store_true",
        help="print parsed JSON without sending it to Supabase",
    )
    bandwidth.add_argument("--binary", default="iperf3", help=argparse.SUPPRESS)

    path = subparsers.add_parser(
        "path-test",
        help="run one on-demand mtr JSON path measurement",
    )
    path.add_argument("target", help="path diagnostic hostname or IP")
    path.add_argument(
        "--source-label",
        default=socket.gethostname(),
        help="human-readable source/location label",
    )
    path.add_argument(
        "--target-label",
        help="human-readable target label (defaults to target)",
    )
    path.add_argument(
        "--connection-type",
        required=True,
        choices=("wifi", "ethernet"),
        help="explicit client transport; never inferred from the WSL interface",
    )
    path.add_argument("--count", type=int, default=5)
    path.add_argument("--timeout", type=float, default=120.0)
    path.add_argument(
        "--no-upload",
        action="store_true",
        help="print parsed JSON without sending it to Supabase",
    )
    path.add_argument("--binary", default="mtr", help=argparse.SUPPRESS)

    diagnostic = subparsers.add_parser(
        "diagnostic-run",
        help="run controlled upload, download, and path diagnostics as JSON Lines",
    )
    diagnostic.add_argument("target", help="allow-listed target hostname or IP")
    diagnostic.add_argument("--job-id", required=True)
    diagnostic.add_argument("--source-label", required=True)
    diagnostic.add_argument("--target-label", required=True)
    diagnostic.add_argument(
        "--connection-type",
        required=True,
        choices=("wifi", "ethernet"),
    )
    diagnostic.add_argument(
        "--environment",
        required=True,
        choices=("lan", "localhost_demo"),
    )
    diagnostic.add_argument("--duration", type=int, required=True, choices=(5, 10, 15, 30))
    diagnostic.add_argument("--port", type=int, default=5201)
    diagnostic.add_argument("--mtr-count", type=int, default=5)
    diagnostic.add_argument("--iperf-binary", default="iperf3", help=argparse.SUPPRESS)
    diagnostic.add_argument("--mtr-binary", default="mtr", help=argparse.SUPPRESS)

    traffic = subparsers.add_parser("traffic-live", help="run a bounded header-only live traffic capture")
    traffic.add_argument("--runner-id", required=True)
    traffic.add_argument("--session-id", required=True)
    traffic.add_argument("--duration", type=int, required=True, choices=(300, 600, 900, 1800))
    traffic.add_argument("--interface", required=True)
    traffic_check = subparsers.add_parser("traffic-interface-check", help=argparse.SUPPRESS)
    traffic_check.add_argument("--interface", required=True)

    inspector = subparsers.add_parser(
        "device-inspect",
        help="inspect one authorized private IP and emit normalized JSON Lines",
    )
    inspector.add_argument("target")
    inspector.add_argument("--route-role", required=True, choices=("default_gateway", "on_link", "routed"))
    inspector.add_argument("--default-gateway")
    inspector.add_argument("--same-subnet", required=True, choices=("yes", "no"))
    inspector.add_argument("--mac")
    inspector.add_argument("--reachable", required=True, choices=("yes", "no"))
    inspector.add_argument("--is-this-device", required=True, choices=("yes", "no"))
    inspector.add_argument("--interface-index", required=True, type=int)
    inspector.add_argument("--interface-alias", required=True)
    inspector.add_argument("--interface-description", required=True)
    inspector.add_argument("--interface-type", required=True, choices=("physical", "virtual", "unknown"))

    return parser


def _run_device_inspection(args: argparse.Namespace) -> None:
    from .device_inspector import inspect_device

    emit = lambda event: print(json.dumps(event, separators=(",", ":")), flush=True)
    fingerprint = inspect_device(
        args.target,
        {
            "route_role": args.route_role,
            "default_gateway": args.default_gateway,
            "same_subnet": args.same_subnet == "yes",
            "mac": args.mac,
            "reachable": args.reachable == "yes",
            "is_this_device": args.is_this_device == "yes",
            "interface_index": args.interface_index,
            "interface_alias": args.interface_alias,
            "interface_description": args.interface_description,
            "interface_type": args.interface_type,
        },
        emit,
    )
    emit({"type": "result", "fingerprint": fingerprint})


def _run_traffic_live(args: argparse.Namespace) -> None:
    from .config import TrafficSettings
    from .traffic_delivery import TrafficClient
    from .traffic_live import run_traffic_capture
    settings = TrafficSettings.from_env()
    emit = lambda event: print(json.dumps(event, separators=(",", ":")), flush=True)
    run_traffic_capture(runner_id=args.runner_id, session_id=args.session_id,
                        duration_seconds=args.duration, interface=args.interface,
                        client=TrafficClient(settings.supabase_url, settings.service_role_key,
                                             settings.request_timeout_seconds),
                        buffer_path=settings.buffer_path, emit=emit)


def _upload_bandwidth(measurement: object) -> None:
    from .config import DiagnosticsSettings
    from .diagnostics import BandwidthMeasurement
    from .diagnostics_delivery import DiagnosticsClient

    if not isinstance(measurement, BandwidthMeasurement):
        raise DiagnosticDeliveryError("Invalid bandwidth measurement")
    settings = DiagnosticsSettings.from_env()
    DiagnosticsClient(
        settings.supabase_url,
        settings.service_role_key,
        settings.request_timeout_seconds,
    ).push_bandwidth(measurement)


def _upload_hops(measurements: object) -> None:
    from .config import DiagnosticsSettings
    from .diagnostics import HopMeasurement
    from .diagnostics_delivery import DiagnosticsClient

    if not isinstance(measurements, list) or not all(
        isinstance(item, HopMeasurement) for item in measurements
    ):
        raise DiagnosticDeliveryError("Invalid hop measurements")
    settings = DiagnosticsSettings.from_env()
    DiagnosticsClient(
        settings.supabase_url,
        settings.service_role_key,
        settings.request_timeout_seconds,
    ).push_hops(measurements)


def _run_diagnostic_job(args: argparse.Namespace) -> None:
    from .config import DiagnosticsSettings
    from .diagnostics_delivery import DiagnosticsClient

    settings = DiagnosticsSettings.from_env()
    client = DiagnosticsClient(
        settings.supabase_url,
        settings.service_role_key,
        settings.request_timeout_seconds,
    )

    def emit(event: dict[str, object]) -> None:
        print(json.dumps(event, separators=(",", ":")), flush=True)

    try:
        run_diagnostic_suite(
            job_id=args.job_id,
            target=args.target,
            source_label=args.source_label,
            target_label=args.target_label,
            connection_type=args.connection_type,
            duration_seconds=args.duration,
            port=args.port,
            environment=args.environment,
            client=client,
            emit=emit,
            iperf_binary=args.iperf_binary,
            mtr_binary=args.mtr_binary,
            mtr_count=args.mtr_count,
        )
    except DiagnosticRunError as exc:
        emit({"type": "error", "code": exc.code, "message": exc.safe_message})
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
