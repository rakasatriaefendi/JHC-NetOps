#!/usr/bin/env python3
"""Prepare the Windows/WSL diagnostics runner and wait for a fresh heartbeat."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNNER_ROOT = PROJECT_ROOT / "runner"
CONFIG_PATH = RUNNER_ROOT / "config.local.json"
TASK_SCRIPT = RUNNER_ROOT / "task.ps1"
POWERSHELL = Path(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
)
HEARTBEAT_TIMEOUT_SECONDS = 35


def main() -> int:
    if sys.platform == "win32":
        return _run_windows_launcher()

    if not _is_wsl():
        print(
            "Script ini harus dijalankan melalui start-diagnostics.ps1 agar "
            "memakai Python virtualenv WSL project.",
            file=sys.stderr,
        )
        return 2

    try:
        config = _load_config()
        _load_environment(config)
        _require_backend_environment()

        print("[1/3] Memeriksa Windows Task Scheduler...")
        status = _run_task("status", check=False)
        if status.returncode != 0:
            print("      Task belum terpasang; memasang auto-start...")
            _run_task("install")
        else:
            print("      Task sudah terpasang.")

        print("[2/3] Menyalakan local diagnostic runner...")
        _run_task("start")

        print("[3/3] Menunggu heartbeat Supabase...")
        health = _wait_for_online(config["runner_id"])
        print(
            "ONLINE — heartbeat "
            f"{health['heartbeat_age_seconds']:.1f} detik lalu; "
            "LAN Diagnostics siap digunakan."
        )
        print(
            "Buka/refresh halaman /diagnostics atau /traffic lalu pastikan "
            "Runner Health = ONLINE."
        )
        return 0
    except LauncherError as exc:
        print(f"GAGAL — {exc}", file=sys.stderr)
        return 2


class LauncherError(RuntimeError):
    """Safe launcher failure suitable for terminal output."""


def _load_config() -> dict[str, Any]:
    if not CONFIG_PATH.is_file():
        raise LauncherError("runner/config.local.json tidak ditemukan")
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LauncherError("runner/config.local.json tidak valid") from exc
    if not isinstance(value, dict) or not isinstance(value.get("runner_id"), str):
        raise LauncherError("runner_id pada config.local.json tidak valid")
    return value


def _load_environment(config: dict[str, Any]) -> None:
    configured = config.get("environment_file", ".env")
    if not isinstance(configured, str) or not configured.strip():
        raise LauncherError("environment_file pada config.local.json tidak valid")
    env_path = (RUNNER_ROOT / configured).resolve()
    if not env_path.is_file():
        raise LauncherError("environment file runner tidak ditemukan")
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise LauncherError("environment file runner tidak dapat dibaca") from exc

    for line in lines:
        candidate = line.strip()
        if not candidate or candidate.startswith("#") or "=" not in candidate:
            continue
        if candidate.startswith("export "):
            candidate = candidate[7:].lstrip()
        name, value = candidate.split("=", 1)
        name = name.strip()
        if not name or not name.replace("_", "a").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(name, value)


def _require_backend_environment() -> None:
    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url.startswith(("http://", "https://")) or not key:
        raise LauncherError("credential backend runner belum lengkap")


def _run_task(action: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    if not POWERSHELL.is_file():
        raise LauncherError("Windows PowerShell tidak dapat diakses dari WSL")
    task_path = _windows_path(TASK_SCRIPT)
    result = subprocess.run(
        [
            "/init",
            str(POWERSHELL),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            task_path,
            action,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=30,
    )
    if check and result.returncode != 0:
        raise LauncherError(f"Task Scheduler action '{action}' gagal")
    return result


def _windows_path(path: Path) -> str:
    result = subprocess.run(
        ["/usr/bin/wslpath", "-w", str(path)],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise LauncherError("path project tidak dapat dikonversi ke path Windows")
    return result.stdout.strip()


def _wait_for_online(runner_id: str) -> dict[str, Any]:
    import requests

    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"Authorization": f"Bearer {key}", "apikey": key}
    deadline = time.monotonic() + HEARTBEAT_TIMEOUT_SECONDS
    latest_error_code: str | None = None

    while time.monotonic() < deadline:
        try:
            response = requests.get(
                f"{url}/rest/v1/diagnostic_runners",
                params={
                    "select": "id,last_seen_at,health_status,health_error_code",
                    "id": f"eq.{runner_id}",
                },
                headers=headers,
                timeout=10,
            )
            response.raise_for_status()
            rows = response.json()
        except (requests.RequestException, ValueError):
            rows = []

        if isinstance(rows, list) and rows:
            runner = rows[0]
            latest_error_code = runner.get("health_error_code")
            age = _timestamp_age(runner.get("last_seen_at"))
            if runner.get("health_status") == "online" and age <= 30:
                return {"heartbeat_age_seconds": age}
        time.sleep(2)

    if latest_error_code:
        raise LauncherError(f"runner degraded: {latest_error_code}")
    raise LauncherError(
        "heartbeat belum online setelah 35 detik; cek runner/logs/runner.log"
    )


def _timestamp_age(value: Any) -> float:
    if not isinstance(value, str):
        return float("inf")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/sys/kernel/osrelease").read_text(
            encoding="utf-8"
        ).lower()
    except OSError:
        return False


def _run_windows_launcher() -> int:
    launcher = PROJECT_ROOT / "start-diagnostics.ps1"
    if not launcher.is_file():
        print("GAGAL — start-diagnostics.ps1 tidak ditemukan", file=sys.stderr)
        return 2
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(launcher),
            ],
            check=False,
        )
    except OSError:
        print("GAGAL — Windows PowerShell tidak dapat dijalankan", file=sys.stderr)
        return 2
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
