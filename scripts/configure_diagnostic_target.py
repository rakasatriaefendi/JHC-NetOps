#!/usr/bin/env python3
"""Manage the runner's local LAN diagnostic target allow-list safely."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "runner" / "config.local.json"
TARGET_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$", re.IGNORECASE)
RFC1918_NETWORKS = tuple(
    ipaddress.IPv4Network(cidr)
    for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    try:
        config = _load_config(args.config)
        if args.command == "list":
            _list_targets(config)
            return 0
        if args.command == "add":
            _add_target(config, args)
        else:
            _set_enabled(config, args.target_id, args.command == "enable")
        _write_config(args.config, config)
    except TargetConfigError as exc:
        parser.error(str(exc))

    print(f"Allow-list diperbarui: {args.config}")
    print("Restart runner agar target baru tampil di LAN Diagnostics:")
    print(r"  powershell -ExecutionPolicy Bypass -File runner\task.ps1 restart")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Tambah/nonaktifkan server LAN yang telah diotorisasi. "
            "Tool ini hanya menerima alamat IPv4 private RFC1918."
        )
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="path config runner (default: runner/config.local.json)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="tampilkan seluruh target lokal")

    add = commands.add_parser("add", help="tambahkan target LAN terotorisasi")
    add.add_argument("--id", required=True, dest="target_id", help="ID stabil, contoh: server-253")
    add.add_argument("--label", required=True, help='label UI, contoh: "Server 253"')
    add.add_argument("--ip", required=True, help="IPv4 server, contoh: 192.168.10.253")
    add.add_argument("--port", type=int, default=5201, help="port iperf3 (default: 5201)")

    for name in ("enable", "disable"):
        command = commands.add_parser(name, help=f"{name} target tanpa menghapus audit config")
        command.add_argument("target_id", help="ID target pada allow-list")
    return parser


class TargetConfigError(RuntimeError):
    """A safe validation error intended for terminal display."""


def _load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise TargetConfigError(f"config tidak ditemukan: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise TargetConfigError(f"config JSON tidak valid: {path}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("targets"), list):
        raise TargetConfigError("field targets pada config harus berupa array")
    return value


def _add_target(config: dict[str, Any], args: argparse.Namespace) -> None:
    target_id = args.target_id.strip()
    label = args.label.strip()
    if not TARGET_ID.fullmatch(target_id):
        raise TargetConfigError("ID hanya boleh huruf, angka, underscore, atau dash (maks. 64 karakter)")
    if not label or len(label) > 200 or "\n" in label or "\r" in label:
        raise TargetConfigError("label target tidak valid")
    try:
        address = ipaddress.IPv4Address(args.ip.strip())
    except ipaddress.AddressValueError as exc:
        raise TargetConfigError("IP harus IPv4 lengkap dengan empat oktet bernilai 0-255") from exc
    if not any(address in network for network in RFC1918_NETWORKS):
        raise TargetConfigError("target LAN harus memakai IPv4 private RFC1918")
    if not 1 <= args.port <= 65535:
        raise TargetConfigError("port harus berada pada rentang 1-65535")

    targets = config["targets"]
    if len(targets) >= 50:
        raise TargetConfigError("allow-list sudah mencapai batas 50 target")
    if any(target.get("id") == target_id for target in targets if isinstance(target, dict)):
        raise TargetConfigError(f"target ID '{target_id}' sudah ada")
    if any(target.get("host") == str(address) for target in targets if isinstance(target, dict)):
        raise TargetConfigError(f"IP '{address}' sudah ada pada allow-list")

    targets.append(
        {
            "id": target_id,
            "label": label,
            "host": str(address),
            "iperf_port": args.port,
            "environment": "lan",
            "enabled": True,
        }
    )


def _set_enabled(config: dict[str, Any], target_id: str, enabled: bool) -> None:
    for target in config["targets"]:
        if isinstance(target, dict) and target.get("id") == target_id:
            target["enabled"] = enabled
            return
    raise TargetConfigError(f"target ID '{target_id}' tidak ditemukan")


def _list_targets(config: dict[str, Any]) -> None:
    targets = config["targets"]
    if not targets:
        print("Belum ada target pada allow-list.")
        return
    print(f"{'ID':<22} {'IP/HOST':<18} {'PORT':<7} {'ENV':<16} STATUS")
    for target in targets:
        if not isinstance(target, dict):
            continue
        print(
            f"{str(target.get('id', '-')):<22} "
            f"{str(target.get('host', '-')):<18} "
            f"{str(target.get('iperf_port', '-')):<7} "
            f"{str(target.get('environment', '-')):<16} "
            f"{'enabled' if target.get('enabled', True) else 'disabled'}"
        )


def _write_config(path: Path, config: dict[str, Any]) -> None:
    backup = path.with_suffix(path.suffix + ".bak")
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        shutil.copy2(path, backup)
        temporary.write_text(
            json.dumps(config, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    except OSError as exc:
        raise TargetConfigError("config tidak dapat ditulis; backup asli tetap dipertahankan") from exc


if __name__ == "__main__":
    raise SystemExit(main())
