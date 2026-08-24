"""Entry point for the portable basic network monitoring agent."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from collections.abc import Sequence

from .diagnostics import (
    DiagnosticCommandError,
    measurements_to_json,
    run_iperf3,
    run_mtr,
)
from .diagnostics_delivery import DiagnosticDeliveryError
from .inspection_trace import InspectionTrace
from .streaming import DiagnosticRunError, run_diagnostic_suite


def main(argv: Sequence[str] | None = None) -> None:
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    inspection_trace = InspectionTrace() if raw_argv[:1] == ["device-inspect"] else None
    if inspection_trace:
        inspection_trace.emit("cli_entry")
    parser = _build_parser()
    args = parser.parse_args(raw_argv)

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
            _run_device_inspection(args, inspection_trace)
            return
        if args.command == "managed-telemetry-poll":
            _run_managed_telemetry_poll(args)
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

    telemetry = subparsers.add_parser(
        "managed-telemetry-poll",
        help="run one SNMP read-only telemetry poll for a configured managed target",
    )
    telemetry.add_argument("--target-id", required=True, help="UUID of the managed_telemetry_targets row")
    telemetry.add_argument("--runner-id", required=True, help="UUID of the diagnostic_runners row")
    telemetry.add_argument("--node-id", required=True, help="UUID of the network_nodes row")
    telemetry.add_argument("--ip-address", required=True, help="management IP address (runner-validated)")
    telemetry.add_argument("--credential-profile-ref", required=True, help="local runner credential profile name (non-secret)")
    telemetry.add_argument("--snmp-version", required=True, choices=("3", "2c"), help="SNMP version to use")
    telemetry.add_argument("--snmp-port", type=int, default=161)
    telemetry.add_argument("--username", help="SNMPv3 username (resolved locally on runner)")
    telemetry.add_argument("--auth-protocol", choices=("SHA256", "SHA", "MD5"), help="SNMPv3 auth protocol")
    telemetry.add_argument("--auth-password", help="SNMPv3 auth password (never logged)")
    telemetry.add_argument("--priv-protocol", choices=("AES128", "AES256", "DES"), help="SNMPv3 priv protocol")
    telemetry.add_argument("--priv-password", help="SNMPv3 priv password (never logged)")
    telemetry.add_argument("--community", help="SNMPv2c community (resolved locally on runner, never logged)")
    telemetry.add_argument("--timeout", type=float, default=3.0, help="per-request timeout in seconds")

    return parser


def _run_device_inspection(args: argparse.Namespace, trace: InspectionTrace | None = None) -> None:
    from .device_inspector import InspectionDeadlineExceeded, inspect_device

    emit = lambda event: print(json.dumps(event, separators=(",", ":")), flush=True)
    try:
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
            trace=trace,
        )
    except InspectionDeadlineExceeded:
        _emit_inspection_event(
            {"type": "error", "code": "INSPECTION_TIMEOUT", "message": "Device inspection exceeded its safe internal deadline"},
            trace,
        )
        if trace:
            trace.emit("cli_return", status="failed")
        raise SystemExit(2) from None
    _emit_inspection_event({"type": "result", "fingerprint": fingerprint}, trace)
    if trace:
        trace.emit("cli_return", status="completed")


def _emit_inspection_event(event: dict[str, object], trace: InspectionTrace | None) -> None:
    started = time.monotonic()
    if trace:
        trace.emit("json_serialize_start")
    encoded = json.dumps(event, separators=(",", ":"))
    if trace:
        trace.emit("json_serialize_end", duration_ms=(time.monotonic() - started) * 1000)
    write_started = time.monotonic()
    print(encoded, flush=True)
    if trace:
        trace.emit("stdout_write", duration_ms=(time.monotonic() - write_started) * 1000)


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


def _run_managed_telemetry_poll(args: argparse.Namespace) -> None:
    from .snmp_collector import snmp_telemetry_poll
    from .snmp_transport import SnmpCredentials

    credentials = SnmpCredentials(
        version=args.snmp_version,
        host=args.ip_address,
        port=args.snmp_port,
        username=args.username,
        auth_protocol=args.auth_protocol,
        auth_password=args.auth_password,
        priv_protocol=args.priv_protocol,
        priv_password=args.priv_password,
        community=args.community,
    )

    emit = lambda event: print(json.dumps(event, separators=(",", ":")), flush=True)

    poll = snmp_telemetry_poll(
        credentials=credentials,
        target_id=args.target_id,
        runner_id=args.runner_id,
        node_id=args.node_id,
        ip_address=args.ip_address,
        credential_profile_ref=args.credential_profile_ref,
        timeout_seconds=args.timeout,
        emit=emit,
    )

    emit({"type": "telemetry_result", "payload": poll.to_payload()})


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
