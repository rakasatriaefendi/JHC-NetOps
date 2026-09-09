#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import re
import json
import time
import socket
import platform
import subprocess
import threading
import ipaddress
import shutil
from io import BytesIO
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, jsonify, render_template_string, request, send_file

import pymysql
from pymysql.cursors import DictCursor

try:
    import psutil
except ImportError:
    psutil = None

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    Workbook = None


# =========================================================
# CONFIG
# =========================================================

BASE = Path(__file__).resolve().parent

HOST = os.getenv("NETWORK_INVENTORY_HOST", "0.0.0.0")
PORT = int(os.getenv("NETWORK_INVENTORY_PORT", "5002"))

DB_HOST = os.getenv("NETWORK_INVENTORY_DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("NETWORK_INVENTORY_DB_PORT", "3306"))
DB_NAME = os.getenv("NETWORK_INVENTORY_DB_NAME", "network_inventory")
DB_USER = os.getenv("NETWORK_INVENTORY_DB_USER", "network_inventory")
DB_PASSWORD = os.getenv("NETWORK_INVENTORY_DB_PASSWORD", "GANTI_PASSWORD_KUAT")

# Discovery concurrency. Nmap itself performs parallel discovery.
WORKERS = int(os.getenv("NETWORK_SCAN_WORKERS", "32"))

# TCP ports commonly useful for PC/server/printer/network equipment.
PORTS = [
    21, 22, 23, 25, 53, 80, 81, 110, 135, 139, 143, 443, 445,
    515, 548, 631, 8080, 8443, 9100, 3389, 5900, 62078
]

PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]

app = Flask(__name__)

scan_lock = threading.Lock()

state = {
    "running": False,
    "started": None,
    "finished": None,
    "message": "Belum pernah scan",
    "progress": 0,
    "total": 0,
    "discovered": 0,
    "stage": "idle",
    "error": "",
    "scan_id": None,
}


# =========================================================
# TIME / COMMAND
# =========================================================

def now():
    from zoneinfo import ZoneInfo
    return datetime.now(
        ZoneInfo("Asia/Jakarta")
    ).strftime("%d-%m-%Y %H:%M:%S WIB")


def run_cmd(command, timeout=10):
    try:
        p = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
        return p.stdout or ""
    except Exception as exc:
        return f"__COMMAND_ERROR__ {exc}"


# =========================================================
# MYSQL / MARIADB
# =========================================================

def mysql_server():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=DictCursor,
        connect_timeout=5,
    )


def db():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=DictCursor,
        connect_timeout=5,
    )


def init_db():
    c = mysql_server()
    try:
        with c.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    finally:
        c.close()

    c = db()
    try:
        with c.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    ip VARCHAR(45) NOT NULL,
                    mac VARCHAR(32) DEFAULT '',
                    hostname VARCHAR(255) DEFAULT '',
                    vendor VARCHAR(255) DEFAULT '',
                    os_name VARCHAR(255) DEFAULT '',
                    device_type VARCHAR(100) DEFAULT 'Unknown',
                    ports TEXT,
                    source VARCHAR(255) DEFAULT '',
                    online TINYINT(1) DEFAULT 0,
                    latency_ms DECIMAL(10,2) NULL,
                    first_seen VARCHAR(40) DEFAULT '',
                    last_seen VARCHAR(40) DEFAULT '',
                    scan_time VARCHAR(40) DEFAULT '',
                    raw_json LONGTEXT,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_devices_ip (ip),
                    KEY idx_online (online),
                    KEY idx_mac (mac),
                    KEY idx_hostname (hostname),
                    KEY idx_last_seen (last_seen)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS scans (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    started VARCHAR(40) DEFAULT '',
                    finished VARCHAR(40) DEFAULT '',
                    discovered INT DEFAULT 0,
                    message VARCHAR(500) DEFAULT '',
                    PRIMARY KEY (id),
                    KEY idx_scans_finished (finished)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # ---------------------------------------------------------
            # Persistent scan result / MAC identity / IP history
            # ---------------------------------------------------------
            cur.execute("""
                CREATE TABLE IF NOT EXISTS scan_results (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    scan_id BIGINT UNSIGNED NOT NULL,
                    ip VARCHAR(45) NOT NULL,
                    mac VARCHAR(32) DEFAULT '',
                    hostname VARCHAR(255) DEFAULT '',
                    vendor VARCHAR(255) DEFAULT '',
                    os_name VARCHAR(255) DEFAULT '',
                    os_confidence VARCHAR(20) DEFAULT 'LOW',
                    os_evidence VARCHAR(1000) DEFAULT '',
                    device_type VARCHAR(100) DEFAULT 'Unknown',
                    ports TEXT,
                    source VARCHAR(255) DEFAULT '',
                    online TINYINT(1) DEFAULT 1,
                    latency_ms DECIMAL(10,2) NULL,
                    scan_time VARCHAR(40) DEFAULT '',
                    raw_json LONGTEXT,
                    PRIMARY KEY (id),
                    KEY idx_sr_scan (scan_id),
                    KEY idx_sr_mac (mac),
                    KEY idx_sr_ip (ip),
                    KEY idx_sr_time (scan_time)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS device_identity (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    mac VARCHAR(32) NOT NULL,
                    current_ip VARCHAR(45) DEFAULT '',
                    previous_ip VARCHAR(45) DEFAULT '',
                    hostname VARCHAR(255) DEFAULT '',
                    vendor VARCHAR(255) DEFAULT '',
                    os_name VARCHAR(255) DEFAULT '',
                    os_confidence VARCHAR(20) DEFAULT 'LOW',
                    device_type VARCHAR(100) DEFAULT 'Unknown',
                    first_seen VARCHAR(40) DEFAULT '',
                    last_seen VARCHAR(40) DEFAULT '',
                    online TINYINT(1) DEFAULT 1,
                    ip_change_count INT DEFAULT 0,
                    last_scan_id BIGINT UNSIGNED NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_identity_mac (mac),
                    KEY idx_identity_ip (current_ip),
                    KEY idx_identity_last_seen (last_seen)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS device_ip_history (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    mac VARCHAR(32) NOT NULL,
                    ip VARCHAR(45) NOT NULL,
                    first_seen VARCHAR(40) DEFAULT '',
                    last_seen VARCHAR(40) DEFAULT '',
                    is_current TINYINT(1) DEFAULT 1,
                    change_count INT DEFAULT 0,
                    last_scan_id BIGINT UNSIGNED NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_mac_ip (mac, ip),
                    KEY idx_iph_mac (mac),
                    KEY idx_iph_ip (ip),
                    KEY idx_iph_last_seen (last_seen)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS device_changes (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    scan_id BIGINT UNSIGNED NOT NULL,
                    change_type VARCHAR(30) NOT NULL,
                    mac VARCHAR(32) DEFAULT '',
                    old_mac VARCHAR(32) DEFAULT '',
                    new_mac VARCHAR(32) DEFAULT '',
                    old_ip VARCHAR(45) DEFAULT '',
                    new_ip VARCHAR(45) DEFAULT '',
                    detected_at VARCHAR(40) DEFAULT '',
                    details VARCHAR(1000) DEFAULT '',
                    PRIMARY KEY (id),
                    KEY idx_changes_scan (scan_id),
                    KEY idx_changes_mac (mac),
                    KEY idx_changes_type (change_type),
                    KEY idx_changes_time (detected_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # Extra OS evidence fields on the live inventory.
            cur.execute("""
                SELECT COLUMN_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=%s AND TABLE_NAME='devices'
            """, (DB_NAME,))
            device_cols = {x["COLUMN_NAME"] for x in cur.fetchall()}
            if "os_confidence" not in device_cols:
                cur.execute("ALTER TABLE devices ADD COLUMN os_confidence VARCHAR(20) DEFAULT 'LOW'")
            if "os_evidence" not in device_cols:
                cur.execute("ALTER TABLE devices ADD COLUMN os_evidence VARCHAR(1000) DEFAULT ''")

            # Safe schema upgrades for installations created by the older version.
            cur.execute("""
                SELECT COLUMN_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=%s
                  AND TABLE_NAME='devices'
            """, (DB_NAME,))
            cols = {x["COLUMN_NAME"] for x in cur.fetchall()}

            if "vendor" not in cols:
                cur.execute("ALTER TABLE devices ADD COLUMN vendor VARCHAR(255) DEFAULT ''")
            if "source" not in cols:
                cur.execute("ALTER TABLE devices ADD COLUMN source VARCHAR(255) DEFAULT ''")
            if "raw_json" not in cols:
                cur.execute("ALTER TABLE devices ADD COLUMN raw_json LONGTEXT")

            # Preserve existing inventory as initial MAC identity/history.
            cur.execute("""
                SELECT mac, ip, hostname, vendor, os_name, device_type,
                       first_seen, last_seen, online
                FROM devices
                WHERE mac IS NOT NULL AND TRIM(mac) <> ''
            """)
            legacy_devices = cur.fetchall()
            for d in legacy_devices:
                mac = (d.get("mac") or "").strip().upper()
                if not mac:
                    continue
                cur.execute("""
                    INSERT INTO device_identity
                    (mac,current_ip,previous_ip,hostname,vendor,os_name,device_type,
                     first_seen,last_seen,online,ip_change_count,last_scan_id)
                    VALUES(%s,%s,'',%s,%s,%s,%s,%s,%s,%s,0,NULL)
                    ON DUPLICATE KEY UPDATE
                      current_ip=IF(current_ip='' OR current_ip IS NULL,VALUES(current_ip),current_ip),
                      hostname=IF(hostname='' OR hostname IS NULL,VALUES(hostname),hostname),
                      vendor=IF(vendor='' OR vendor IS NULL,VALUES(vendor),vendor),
                      os_name=IF(os_name='' OR os_name IS NULL,VALUES(os_name),os_name),
                      device_type=IF(device_type='' OR device_type IS NULL,VALUES(device_type),device_type),
                      first_seen=IF(first_seen='' OR first_seen IS NULL,VALUES(first_seen),first_seen),
                      last_seen=IF(last_seen='' OR last_seen IS NULL,VALUES(last_seen),last_seen)
                """, (mac,d.get("ip") or '',d.get("hostname") or '',d.get("vendor") or '',
                      d.get("os_name") or '',d.get("device_type") or 'Unknown',
                      d.get("first_seen") or '',d.get("last_seen") or '',int(bool(d.get("online")))))
                cur.execute("""
                    INSERT INTO device_ip_history
                    (mac,ip,first_seen,last_seen,is_current,change_count,last_scan_id)
                    VALUES(%s,%s,%s,%s,1,0,NULL)
                    ON DUPLICATE KEY UPDATE
                      last_seen=VALUES(last_seen)
                """, (mac,d.get("ip") or '',d.get("first_seen") or '',d.get("last_seen") or ''))
    finally:
        c.close()


# =========================================================
# LOCAL INTERFACES
# =========================================================

def interfaces():
    result = []

    if psutil:
        try:
            for name, addresses in psutil.net_if_addrs().items():
                if name == "lo" or name.startswith("docker") or name.startswith("br-"):
                    continue

                for a in addresses:
                    if a.family != socket.AF_INET:
                        continue
                    if not a.address or not a.netmask:
                        continue

                    try:
                        network = str(
                            ipaddress.ip_network(
                                f"{a.address}/{a.netmask}",
                                strict=False,
                            )
                        )
                    except Exception:
                        network = ""

                    result.append({
                        "interface": name,
                        "ip": a.address,
                        "netmask": a.netmask,
                        "network": network,
                    })
        except Exception:
            pass

    if result:
        return result

    # Fallback for Linux without psutil.
    for line in run_cmd(["ip", "-o", "-4", "addr", "show"]).splitlines():
        m = re.search(
            r"\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)",
            line,
        )
        if not m:
            continue

        name, ip, prefix = m.groups()

        if name == "lo" or name.startswith("docker") or name.startswith("br-"):
            continue

        try:
            network = str(
                ipaddress.ip_network(
                    f"{ip}/{prefix}",
                    strict=False,
                )
            )
        except Exception:
            network = ""

        result.append({
            "interface": name,
            "ip": ip,
            "netmask": "",
            "network": network,
        })

    return result


def scan_networks():
    nets = []

    for item in interfaces():
        try:
            n = ipaddress.ip_network(item["network"], strict=False)

            if n.version != 4:
                continue

            # Do not scan loopback or Docker/private virtual bridges.
            if n.is_loopback:
                continue

            if any(n.subnet_of(p) or n == p for p in PRIVATE_NETWORKS):
                nets.append({
                    "interface": item["interface"],
                    "network": n,
                    "ip": item["ip"],
                })
        except Exception:
            pass

    # Remove duplicate network/interface combinations.
    unique = {}
    for item in nets:
        key = (item["interface"], str(item["network"]))
        unique[key] = item

    return list(unique.values())


# =========================================================
# NMAP DISCOVERY
# =========================================================

def parse_nmap_discovery(text):
    """
    Parse:
      Nmap scan report for hostname (192.168.1.10)
      Nmap scan report for 192.168.1.11
      Host is up (0.0020s latency).
      MAC Address: AA:BB:CC:DD:EE:FF (Vendor)
    """

    found = []
    current = None

    lines = text.splitlines()

    for raw in lines:
        line = raw.strip()

        m = re.match(
            r"Nmap scan report for (.+?) \((\d+\.\d+\.\d+\.\d+)\)$",
            line,
            re.I,
        )

        if m:
            if current and current.get("ip"):
                found.append(current)

            current = {
                "ip": m.group(2),
                "hostname": m.group(1).strip(),
                "mac": "",
                "vendor": "",
                "latency_ms": None,
            }
            continue

        m = re.match(
            r"Nmap scan report for (\d+\.\d+\.\d+\.\d+)$",
            line,
            re.I,
        )

        if m:
            if current and current.get("ip"):
                found.append(current)

            current = {
                "ip": m.group(1),
                "hostname": "",
                "mac": "",
                "vendor": "",
                "latency_ms": None,
            }
            continue

        if not current:
            continue

        m = re.search(
            r"Host is up\s*\(([\d.]+)s latency\)",
            line,
            re.I,
        )
        if m:
            try:
                current["latency_ms"] = round(float(m.group(1)) * 1000, 2)
            except Exception:
                pass

        m = re.match(
            r"MAC Address:\s*([0-9A-Fa-f:]{17})(?:\s+\((.*?)\))?$",
            line,
            re.I,
        )
        if m:
            current["mac"] = m.group(1).upper()
            current["vendor"] = (m.group(2) or "").strip()

    if current and current.get("ip"):
        found.append(current)

    # De-duplicate IPs.
    result = {}
    for item in found:
        result[item["ip"]] = item

    return list(result.values())


def nmap_discover(network):
    if not shutil.which("nmap"):
        return [], "Nmap tidak ditemukan"

    # -sn = host discovery only.
    # -PR = ARP discovery on local Ethernet, excellent for LAN inventory.
    # --send-ip = fallback when ARP is not applicable.
    command = [
        "nmap",
        "-sn",
        "-PR",
        "--send-ip",
        "-T4",
        str(network),
    ]

    text = run_cmd(command, timeout=180)

    if text.startswith("__COMMAND_ERROR__"):
        return [], text

    return parse_nmap_discovery(text), ""


# =========================================================
# NETWORK INFORMATION
# =========================================================

def arp_neighbors():
    result = {}

    text = run_cmd(["ip", "neigh", "show"], timeout=5)

    for line in text.splitlines():
        m = re.search(
            r"^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)"
            r"(?:\s+lladdr\s+([0-9a-fA-F:]{17}))?"
            r"\s+(\S+)",
            line,
        )

        if not m:
            continue

        ip, interface, mac, status = m.groups()

        result[ip] = {
            "interface": interface,
            "mac": mac.upper() if mac else "",
            "state": status.upper(),
        }

    return result


def reverse_hostname(ip):
    try:
        old_timeout = socket.getdefaulttimeout()
        socket.setdefaulttimeout(0.8)
        try:
            return socket.gethostbyaddr(ip)[0].rstrip(".")
        finally:
            socket.setdefaulttimeout(old_timeout)
    except Exception:
        return ""


def ping(ip):
    started = time.perf_counter()

    if platform.system().lower().startswith("win"):
        command = ["ping", "-n", "1", "-w", "1000", ip]
    else:
        command = ["ping", "-c", "1", "-W", "1", ip]

    try:
        rc = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).returncode

        if rc == 0:
            return True, round((time.perf_counter() - started) * 1000, 2)

    except Exception:
        pass

    return False, None


# =========================================================
# PORT / OS / DEVICE FINGERPRINT
# =========================================================

def port_scan(ip):
    if not PORTS:
        return []

    result = []

    for port in PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.25)

        try:
            if sock.connect_ex((ip, port)) == 0:
                result.append(port)
        except Exception:
            pass
        finally:
            sock.close()

    return result


def nmap_fingerprint(ip):
    """
    Nmap OS + service fingerprint.

    IMPORTANT:
    OS detection from Nmap can be empty on Windows because ICMP/OS
    fingerprint probes may be filtered. Therefore the caller MUST also
    use the TCP/service evidence (135/139/445/MSRPC/NetBIOS/SMB).
    """
    if not shutil.which("nmap"):
        return {}

    command = [
        "nmap",
        "-Pn",
        "-O",
        "-sV",
        "--version-light",
        "--osscan-guess",
        "--open",
        "-T4",
        ip,
    ]

    # OS detection normally needs root. systemd installation runs as root,
    # but this also makes manual execution with sudo behave consistently.
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        if shutil.which("sudo"):
            command.insert(0, "sudo")
            command.insert(1, "-n")

    text = run_cmd(command, timeout=60)

    if text.startswith("__COMMAND_ERROR__"):
        return {}

    result = {
        "os_name": "",
        "device_type": "",
        "ports": [],
        "services": [],
    }

    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()

        if line.startswith("OS details:"):
            result["os_name"] = line.split(":", 1)[1].strip()

        elif line.startswith("Running:"):
            if not result["os_name"]:
                result["os_name"] = line.split(":", 1)[1].strip()

        elif line.startswith("Aggressive OS guesses:"):
            if not result["os_name"]:
                result["os_name"] = line.split(":", 1)[1].strip()

        elif line.startswith("Service Info:"):
            # Example: Service Info: OS: Windows; CPE: cpe:/o:microsoft:windows
            if not result["os_name"]:
                m = re.search(r"OS:\s*([^;]+)", line, re.I)
                if m:
                    result["os_name"] = m.group(1).strip()

        elif line.startswith("Device type:"):
            result["device_type"] = line.split(":", 1)[1].strip()

        elif re.match(r"^\d+/(tcp|udp)\s+", line, re.I):
            parts = re.split(r"\s+", line, maxsplit=4)
            if len(parts) >= 3:
                try:
                    port = int(parts[0].split("/", 1)[0])
                    if port not in result["ports"]:
                        result["ports"].append(port)

                    service = " ".join(parts[2:]).strip()
                    if service:
                        result["services"].append({
                            "port": port,
                            "text": service,
                        })
                except Exception:
                    pass

    return result

def infer_os(hostname, ports, nmap_os, services, vendor=""):
    """Determine OS from Nmap JSON-equivalent data + TCP/service evidence."""
    nmap_os = (nmap_os or "").strip()
    host = (hostname or "").lower()
    ven = (vendor or "").lower()

    service_parts = []
    for item in services or []:
        if isinstance(item, dict):
            service_parts.append(str(item.get("text", "")))
        else:
            service_parts.append(str(item))
    service_text = " ".join(service_parts).lower()
    pset = set(int(p) for p in (ports or []) if str(p).isdigit())
    evidence = []

    # 1. Trust explicit Nmap OS result ONLY when it is a real OS value.
    # Nmap/service output can otherwise put product/service descriptions
    # (HP iLO, printer, bridge, etc.) into an OS-like field.
    if nmap_os:
        low = nmap_os.lower()
        if any(x in low for x in ("windows", "microsoft")):
            return "Windows", "HIGH", "Nmap OS: " + nmap_os
        if any(x in low for x in (
            "linux", "ubuntu", "debian", "centos", "red hat", "unix"
        )):
            return "Linux / Unix", "HIGH", "Nmap OS: " + nmap_os
        if any(x in low for x in ("mac os", "macos", "darwin")):
            return "macOS / Apple", "HIGH", "Nmap OS: " + nmap_os
        if "android" in low:
            return "Android", "HIGH", "Nmap OS: " + nmap_os
        if any(x in low for x in ("freebsd", "openbsd", "netbsd")):
            return "FreeBSD / BSD", "HIGH", "Nmap OS: " + nmap_os
        if any(x in low for x in ("routeros", "junos", "cisco ios", "ios-xe")):
            return "Network OS", "HIGH", "Nmap OS: " + nmap_os
        evidence.append("Nmap OS candidate ignored: " + nmap_os)

    # 2. WINDOWS FALLBACK.
    # A Windows workstation can have firewall/ICMP filtering and Nmap -O
    # can consequently return no OS. TCP 135 + 139 + 445 is a very strong
    # Windows signature. 3389 is optional and is often disabled.
    windows_score = 0
    windows_ports = []
    for port, weight in (
        (445, 5),
        (139, 4),
        (135, 4),
        (3389, 4),
        (593, 2),
    ):
        if port in pset:
            windows_score += weight
            windows_ports.append(str(port))

    if windows_ports:
        evidence.append("TCP/" + ", ".join(windows_ports))

    microsoft_markers = (
        "microsoft-ds",
        "microsoft windows",
        "msrpc",
        "netbios-ssn",
        "microsoft terminal services",
        "microsoft-ds?",
        "windows",
        "smb",
        "cifs",
    )
    matched_markers = [x for x in microsoft_markers if x in service_text]
    if matched_markers:
        windows_score += 5
        evidence.append("Service: " + ", ".join(matched_markers))

    if "microsoft" in ven:
        windows_score += 2
        evidence.append("Vendor: Microsoft")

    if windows_score >= 4:
        return (
            "Windows",
            "HIGH" if windows_score >= 7 else "MEDIUM",
            "; ".join(evidence),
        )

    # 3. Linux / Unix.
    if 22 in pset:
        evidence.append("TCP/22 SSH")
        if any(x in service_text for x in ("openssh", "dropbear", "linux")):
            evidence.append("SSH/Linux service")
            return "Linux / Unix", "HIGH", "; ".join(evidence)
        return "Linux / Unix", "MEDIUM", "; ".join(evidence)

    if any(x in (host + " " + ven) for x in (
        "ubuntu", "debian", "centos", "red hat", "linux"
    )):
        return "Linux / Unix", "MEDIUM", "Hostname/vendor Linux signature"

    if "android" in service_text:
        return "Android", "MEDIUM", "Android service"

    if any(x in service_text for x in ("apple", "darwin", "macos", "mac os")):
        return "macOS / Apple", "MEDIUM", "Apple/Darwin service"

    return "Unknown", "LOW", "No reliable OS signature"


def vendor_device_type(vendor="", hostname="", ports=None, services=None,
                       os_name="", nmap_type=""):
    """Evidence-first Vendor -> Device Type classifier.

    IMPORTANT: TCP/631 or TCP/9100 alone is NOT enough to call a device a
    printer. Linux servers, NAS and other appliances may expose print ports.
    Vendor/model/service evidence gets priority; generic ports are only used
    as supporting evidence.
    """
    ven=(vendor or "").strip()
    lowv=ven.lower()
    lowh=(hostname or "").lower()
    lowo=(os_name or "").lower()
    lowt=(nmap_type or "").lower()
    pset=set(int(p) for p in (ports or []) if str(p).isdigit())
    service_text=" ".join(
        str(x.get("text","")) if isinstance(x,dict) else str(x)
        for x in (services or [])
    ).lower()
    text=" ".join([lowv,lowh,lowo,lowt,service_text])

    # -----------------------------------------------------
    # 1. Very specific product / service signatures
    # -----------------------------------------------------
    if any(x in text for x in (
        "ilo 2","ilo 3","ilo 4","ilo 5","ilo 6",
        "integrated lights-out","hp ilo","proliant ilo"
    )):
        return "Server / Remote Management"

    if any(x in text for x in (
        "audiocodes","voip gateway","mp-1xx","mp11","mediant",
        "voip adapter"
    )):
        return "VoIP Gateway"

    if any(x in text for x in (
        "philips hue","hue bridge","osram lightify","zigbee gateway",
        "lightify","smartplug","smart plug","iot gateway","iot device"
    )):
        return "IoT / Smart Home"

    if any(x in text for x in (
        "keyence","sensor/controller","industrial controller","plc","hmi"
    )):
        return "Industrial Controller"

    if any(x in text for x in (
        "hikvision","dahua","axis communications","axis camera",
        "cctv","ip camera","network camera"
    )):
        return "CCTV / Camera"

    if any(x in text for x in (
        "mindray","patient monitor","medical device","medical equipment"
    )):
        return "Medical Device"

    # -----------------------------------------------------
    # 2. Network infrastructure: do NOT let "cisco" imply router blindly.
    # -----------------------------------------------------
    if any(x in text for x in ("switch","switching", "sg250", "catalyst")):
        if any(x in text for x in ("cisco","juniper","aruba","hpe","hewlett" ,"netgear","tp-link","d-link")):
            return "Switch / Network"

    if any(x in text for x in ("access point","wireless access point","wifi ap","wlan ap")):
        return "Access Point"

    if any(x in text for x in ("routeros","mikrotik","router","firewall")):
        return "Router / Firewall"

    # Cisco / TP-Link / network vendors without enough evidence are still
    # network equipment, but not falsely forced to Router.
    if any(x in lowv for x in (
        "cisco systems","cisco","juniper networks","juniper",
        "aruba networks","tp-link","d-link","netgear"
    )):
        if any(x in lowh for x in ("switch","sg","catalyst")) or "switch" in lowt:
            return "Switch / Network"
        if any(x in lowh for x in ("router","gateway","firewall")) or "router" in lowt:
            return "Router / Firewall"
        if any(x in lowh for x in ("ap","accesspoint","access-point","wifi","wlan")):
            return "Access Point"
        return "Network Device"

    # -----------------------------------------------------
    # 3. Storage / server vendors
    # -----------------------------------------------------
    if any(x in lowv for x in ("asustor","synology","qnap systems","qnap")):
        return "NAS / Storage Server"

    if any(x in lowv for x in (
        "hewlett packard enterprise","hewlett-packard enterprise",
        "hpe","hp enterprise"
    )):
        if any(x in text for x in ("server","proliant","ilo","xeon")):
            return "Server"
        # HPE is a server/network vendor; never label it Printer from 631/9100.
        if 22 in pset or ({80,443,445,3389} & pset):
            return "Server / Computer"
        return "Server / Network"

    # -----------------------------------------------------
    # 4. Real printer vendors/models ONLY with printer evidence.
    # -----------------------------------------------------
    printer_vendor = any(x in lowv for x in (
        "seiko epson","epson","brother industries","brother",
        "canon","ricoh","xerox","kyocera","lexmark",
        "zebra technologies","zebra printer"
    ))
    printer_words = any(x in text for x in (
        "printer","print server","ipp","jetdirect","lpd","cups",
        "laserjet","deskjet","officejet","ecotank","workforce",
        "mfp","multifunction printer","print service"
    ))
    # Dedicated printer manufacturers are strong vendor evidence by themselves.
    # This fixes Epson/Brother/Canon/Ricoh/etc. even when Nmap service output is sparse.
    if printer_vendor:
        return "Printer"
    if "printer" in lowt and printer_words:
        return "Printer"
    # A printer vendor with print ports + service evidence is enough.
    if printer_vendor and any(p in pset for p in (515,631,9100)) and any(
        x in service_text for x in ("ipp","jetdirect","printer","lpd","cups")
    ):
        return "Printer"

    # HP/ Hewlett Packard is ambiguous: HPE and HP computer/server devices
    # are common. Only call Printer when print evidence is explicit.
    if any(x in lowv for x in ("hewlett packard","hewlett-packard","hp inc","hp")):
        if printer_words and any(p in pset for p in (515,631,9100)):
            return "Printer"
        if any(x in text for x in ("proliant","server","ilo")):
            return "Server"
        if ({135,139,445,3389} & pset):
            return "Windows PC / Server"
        if 22 in pset:
            return "Linux / Unix / Server"
        return "Computer / Server"

    # -----------------------------------------------------
    # 5. PC / embedded / electronics vendors
    # -----------------------------------------------------
    if any(x in lowv for x in (
        "elitegroup computer systems","elitegroup",
        "giga-byte technology","gigabyte","wistron",
        "dell","lenovo","acer","asustek computer","asustek",
        "micro-star","msi"
    )):
        if ({135,139,445,3389} & pset):
            return "Windows PC / Server"
        if 22 in pset or "linux" in lowo:
            return "Linux / Unix / Server"
        return "Computer / Workstation"

    if "raspberry pi foundation" in lowv or "raspberry pi" in lowv:
        if 22 in pset or "linux" in lowo:
            return "Linux / Unix / Server"
        return "Embedded / IoT"

    if "apple" in lowv:
        return "Mac / Apple Workstation"

    if any(x in lowv for x in ("xiaomi communications","xiaomi")):
        return "Android / IoT"

    if any(x in lowv for x in ("samsung electronics","samsung")):
        if "android" in lowo or "android" in service_text:
            return "Android / Smart Device"
        return "Smart Device / Electronics"

    if any(x in lowv for x in ("changhong","tcl","hisense")):
        return "Smart TV / IoT"

    # -----------------------------------------------------
    # 6. Generic OS evidence is handled by classify_device().
    # -----------------------------------------------------
    return ""


def classify_device(hostname, ports, os_name, nmap_type="", vendor="", services=None):
    """Classify device using vendor/product evidence first, then OS/ports.

    Never classify as Printer merely because TCP/631 or TCP/9100 is open.
    """
    services=services or []
    pset=set(ports or [])
    text=" ".join([
        hostname or "", os_name or "", nmap_type or "", vendor or "",
        " ".join(str(x.get("text", "")) for x in services if isinstance(x,dict)),
    ]).lower()

    # Strong vendor/product evidence first.
    vh=vendor_device_type(vendor,hostname,ports,services,os_name,nmap_type)
    if vh:
        return vh

    # Nmap device type is useful when it is a real generic class.
    nt=(nmap_type or "").lower()
    if "printer" in nt:
        return "Printer"
    if "router" in nt or "firewall" in nt:
        return "Router / Firewall"
    if "switch" in nt:
        return "Switch / Network"
    if "access point" in nt or "wireless" in nt:
        return "Access Point"
    if "storage" in nt:
        return "NAS / Storage Server"
    if "server" in nt and "windows" in (os_name or "").lower():
        return "Windows PC / Server"

    # Explicit printer model/service evidence. Ports alone are insufficient.
    printer_service=any(
        x in text for x in (
            "printer","print server","jetdirect","ipp printer",
            "lpd printer","cups printer","laserjet","deskjet",
            "officejet","ecotank","workforce","mfp"
        )
    )
    printer_vendor=any(
        x in (vendor or "").lower() for x in (
            "epson","brother","canon","ricoh","xerox","kyocera","lexmark","zebra"
        )
    )
    if printer_service and (printer_vendor or any(p in pset for p in (515,631,9100))):
        return "Printer"

    # Network text signatures, after vendor-specific rules.
    if any(x in text for x in ("routeros","mikrotik","firewall","router")):
        return "Router / Firewall"
    if any(x in text for x in ("access point","wireless ap","wifi ap","wlan ap")):
        return "Access Point"
    if "switch" in text:
        return "Switch / Network"
    if any(x in text for x in ("camera","cctv","hikvision","dahua","axis camera")):
        return "CCTV / Camera"

    # OS-based fallback. This is deliberately after device/vendor rules.
    inferred_os,_,_=infer_os(hostname,ports,os_name,services,vendor)
    if inferred_os=="Windows":
        return "Windows PC / Server"
    if inferred_os=="Linux / Unix":
        return "Linux / Unix / Server"
    if inferred_os=="macOS / Apple":
        return "Mac / Apple Workstation"
    if inferred_os=="Android":
        return "Android / Smart Device"

    # Generic web service is last, never before vendor classification.
    if any(p in pset for p in (80,443,8080,8443)):
        return "Web Device"

    return "Unknown"


# =========================================================
# VENDOR → DEVICE TYPE SUMMARY
# =========================================================

def build_vendor_type_summary(devices):
    counts={}
    for d in devices:
        vendor=(d.get("vendor") or "").strip() or "Unknown Vendor"
        dtype=(d.get("device_type") or "Unknown").strip() or "Unknown"
        key=(vendor,dtype)
        counts[key]=counts.get(key,0)+1
    return [
        {"vendor":v,"device_type":t,"count":c}
        for (v,t),c in sorted(
            counts.items(),
            key=lambda x:(-x[1],x[0][0].lower(),x[0][1].lower())
        )
    ]


def build_vendor_summary(devices):
    """One row/card per vendor, with its observed device types."""
    data={}
    for d in devices:
        vendor=(d.get("vendor") or "").strip() or "Unknown Vendor"
        dtype=(d.get("device_type") or "Unknown").strip() or "Unknown"
        item=data.setdefault(vendor,{"vendor":vendor,"count":0,"types":{}})
        item["count"] += 1
        item["types"][dtype] = item["types"].get(dtype,0)+1
    result=[]
    for item in data.values():
        types=sorted(item["types"].items(), key=lambda x:(-x[1],x[0].lower()))
        result.append({
            "vendor":item["vendor"],
            "count":item["count"],
            "types":[{"type":k,"count":v} for k,v in types],
        })
    return sorted(result,key=lambda x:(-x["count"],x["vendor"].lower()))


def repair_device_fingerprint_fields(devices):
    """Repair legacy/bad OS/type/vendor values from raw_json evidence."""
    updates=[]
    for d in devices:
        raw={}
        try:
            raw=json.loads(d.get("raw_json") or "{}")
        except Exception:
            pass

        ports=parse_ports_value(d.get("ports"))
        if not ports:
            ports=raw.get("ports") or []
        services=raw.get("services") or []
        host=d.get("hostname") or raw.get("hostname") or ""
        vendor=d.get("vendor") or raw.get("vendor") or ""
        current_os=(d.get("os_name") or "").strip()
        raw_os=(raw.get("os_name") or "").strip()

        inferred,confidence,evidence=infer_os(
            host,ports,raw_os or current_os,services,vendor
        )
        dtype=classify_device(host,ports,inferred,"",vendor,services)
        # Recalculate type EVERY time so legacy wrong values such as
        # "Printer" on ASUSTOR/HPE/Raspberry Pi are corrected immediately.
        new_type=dtype or "Unknown"
        new_os=inferred if inferred!="Unknown" else "Unknown"

        changed=(
            (d.get("vendor") or "")!=vendor or
            (d.get("os_name") or "")!=new_os or
            (d.get("os_confidence") or "LOW")!=confidence or
            (d.get("os_evidence") or "")!=evidence or
            (d.get("device_type") or "Unknown")!=new_type
        )

        d["vendor"]=vendor
        d["os_name"]=new_os
        d["os_confidence"]=confidence
        d["os_evidence"]=evidence
        d["device_type"]=new_type

        if changed and d.get("id"):
            updates.append((vendor,new_os,confidence,evidence,new_type,d["id"]))

    if updates:
        c=db()
        try:
            with c.cursor() as cur:
                for vendor,os_name,confidence,evidence,dtype,device_id in updates:
                    cur.execute("""
                        UPDATE devices
                        SET vendor=%s,os_name=%s,os_confidence=%s,
                            os_evidence=%s,device_type=%s
                        WHERE id=%s
                    """,(vendor,os_name,confidence,evidence,dtype,device_id))
        finally:
            c.close()
    return devices


# =========================================================
# INVENTORY
# =========================================================

def inspect_device(item, arp):
    ip = item["ip"]
    n = arp.get(ip, {})

    mac = (item.get("mac") or n.get("mac") or "").strip().upper()
    vendor = item.get("vendor") or ""

    host = item.get("hostname") or ""
    if not host:
        host = reverse_hostname(ip)

    ok, ping_latency = ping(ip)
    latency = ping_latency if ping_latency is not None else item.get("latency_ms")

    open_ports = port_scan(ip)
    fp = nmap_fingerprint(ip)

    for p in fp.get("ports", []):
        if p not in open_ports:
            open_ports.append(p)
    open_ports.sort()

    services = fp.get("services", [])
    os_name, os_confidence, os_evidence = infer_os(
        host, open_ports, fp.get("os_name", ""), services, vendor
    )
    device_type = classify_device(
        host, open_ports, os_name, fp.get("device_type", ""), vendor, services
    )

    source_parts = ["nmap-sn"]
    if mac:
        source_parts.append("ARP/MAC")
    if open_ports:
        source_parts.append("TCP")
    if fp:
        source_parts.append("nmap-OS/SV")
    if os_confidence != "LOW":
        source_parts.append("OS-INFERENCE")

    return {
        "ip": ip,
        "mac": mac,
        "hostname": host,
        "vendor": vendor,
        "os_name": os_name,
        "os_confidence": os_confidence,
        "os_evidence": os_evidence,
        "device_type": device_type,
        "ports": open_ports,
        "services": services,
        "online": 1,
        "latency_ms": latency,
        "source": "+".join(source_parts),
        "scan_time": now(),
    }


def save_device(device, scan_id=None):
    """Persist current inventory + immutable scan result + MAC/IP identity."""
    c = db()
    try:
        with c.cursor() as cur:
            now_txt = device["scan_time"]
            mac = (device.get("mac") or "").strip().upper()
            ip = device["ip"]

            cur.execute("SELECT * FROM devices WHERE ip=%s", (ip,))
            old_ip_row = cur.fetchone()

            old_mac_row = None
            if mac:
                cur.execute("SELECT * FROM device_identity WHERE mac=%s", (mac,))
                old_mac_row = cur.fetchone()

            old_ip_for_mac = (old_mac_row.get("current_ip") or "") if old_mac_row else ""
            old_mac_for_ip = (old_ip_row.get("mac") or "").strip().upper() if old_ip_row else ""

            # A MAC seen on a different IP = IP_CHANGED.
            if mac and old_mac_row and old_ip_for_mac and old_ip_for_mac != ip:
                cur.execute("""
                    INSERT INTO device_changes
                    (scan_id,change_type,mac,old_ip,new_ip,detected_at,details)
                    VALUES(%s,'IP_CHANGED',%s,%s,%s,%s,%s)
                """, (scan_id or 0,mac,old_ip_for_mac,ip,now_txt,
                      f"MAC {mac}: {old_ip_for_mac} -> {ip}"))

            # Same IP with a different MAC = MAC_CHANGED.
            if old_mac_for_ip and mac and old_mac_for_ip != mac:
                cur.execute("""
                    INSERT INTO device_changes
                    (scan_id,change_type,mac,old_mac,new_mac,old_ip,new_ip,detected_at,details)
                    VALUES(%s,'MAC_CHANGED',%s,%s,%s,%s,%s,%s,%s)
                """, (scan_id or 0,mac,old_mac_for_ip,mac,ip,ip,now_txt,
                      f"IP {ip}: {old_mac_for_ip} -> {mac}"))

            # Brand-new MAC identity.
            if mac and not old_mac_row:
                cur.execute("""
                    INSERT INTO device_changes
                    (scan_id,change_type,mac,new_ip,detected_at,details)
                    VALUES(%s,'NEW_DEVICE',%s,%s,%s,%s)
                """, (scan_id or 0,mac,ip,now_txt,f"MAC {mac} pertama kali terlihat di {ip}"))

            # Keep identity record current.
            if mac:
                cur.execute("""
                    INSERT INTO device_identity
                    (mac,current_ip,previous_ip,hostname,vendor,os_name,os_confidence,device_type,
                     first_seen,last_seen,online,ip_change_count,last_scan_id)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,0,%s)
                    ON DUPLICATE KEY UPDATE
                      previous_ip=IF(current_ip<>VALUES(current_ip),current_ip,previous_ip),
                      current_ip=VALUES(current_ip),
                      hostname=VALUES(hostname),
                      vendor=VALUES(vendor),
                      os_name=VALUES(os_name),
                      os_confidence=VALUES(os_confidence),
                      device_type=VALUES(device_type),
                      last_seen=VALUES(last_seen),
                      online=1,
                      ip_change_count=ip_change_count+IF(current_ip<>VALUES(current_ip),1,0),
                      last_scan_id=VALUES(last_scan_id)
                """, (
                    mac,ip,old_ip_for_mac,device.get("hostname") or "",device.get("vendor") or "",
                    device.get("os_name") or "",device.get("os_confidence") or "LOW",
                    device.get("device_type") or "Unknown",now_txt,now_txt,scan_id
                ))

                cur.execute("UPDATE device_ip_history SET is_current=0 WHERE mac=%s", (mac,))
                cur.execute("""
                    INSERT INTO device_ip_history
                    (mac,ip,first_seen,last_seen,is_current,change_count,last_scan_id)
                    VALUES(%s,%s,%s,%s,1,%s,%s)
                    ON DUPLICATE KEY UPDATE
                      last_seen=VALUES(last_seen),
                      is_current=1,
                      change_count=change_count+IF(last_seen<>VALUES(last_seen),1,0),
                      last_scan_id=VALUES(last_scan_id)
                """, (mac,ip,now_txt,now_txt,1 if old_ip_for_mac and old_ip_for_mac != ip else 0,scan_id))

            # Current live inventory remains IP-based for compatibility.
            cur.execute("SELECT first_seen FROM devices WHERE ip=%s", (ip,))
            old = cur.fetchone()
            first_seen = old["first_seen"] if old else now_txt

            cur.execute("""
                INSERT INTO devices
                (ip,mac,hostname,vendor,os_name,os_confidence,os_evidence,device_type,
                 ports,source,online,latency_ms,first_seen,last_seen,scan_time,raw_json)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  mac=VALUES(mac), hostname=VALUES(hostname), vendor=VALUES(vendor),
                  os_name=VALUES(os_name), os_confidence=VALUES(os_confidence),
                  os_evidence=VALUES(os_evidence), device_type=VALUES(device_type),
                  ports=VALUES(ports), source=VALUES(source), online=1,
                  latency_ms=VALUES(latency_ms), last_seen=VALUES(last_seen),
                  scan_time=VALUES(scan_time), raw_json=VALUES(raw_json)
            """, (
                ip,mac,device.get("hostname") or "",device.get("vendor") or "",
                device.get("os_name") or "Unknown",device.get("os_confidence") or "LOW",
                device.get("os_evidence") or "",device.get("device_type") or "Unknown",
                json.dumps(device.get("ports",[]),ensure_ascii=False),device.get("source") or "",
                device.get("latency_ms"),first_seen,now_txt,now_txt,
                json.dumps(device,ensure_ascii=False)
            ))

            # Immutable result of this device in this scan.
            if scan_id:
                cur.execute("""
                    INSERT INTO scan_results
                    (scan_id,ip,mac,hostname,vendor,os_name,os_confidence,os_evidence,device_type,
                     ports,source,online,latency_ms,scan_time,raw_json)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s)
                """, (
                    scan_id,ip,mac,device.get("hostname") or "",device.get("vendor") or "",
                    device.get("os_name") or "Unknown",device.get("os_confidence") or "LOW",
                    device.get("os_evidence") or "",device.get("device_type") or "Unknown",
                    json.dumps(device.get("ports",[]),ensure_ascii=False),device.get("source") or "",
                    device.get("latency_ms"),now_txt,json.dumps(device,ensure_ascii=False)
                ))
    finally:
        c.close()


# =========================================================
# FULL SCAN
# =========================================================

def do_scan():
    if not scan_lock.acquire(False):
        return

    state.update(
        running=True,
        started=now(),
        finished=None,
        message="Menyiapkan discovery...",
        progress=0,
        total=0,
        discovered=0,
        stage="prepare",
        error="",
        scan_id=None,
    )

    started = state["started"]

    try:
        c = db()
        try:
            with c.cursor() as cur:
                cur.execute(
                    "INSERT INTO scans(started,finished,discovered,message) VALUES(%s,'',0,%s)",
                    (started, "Scan sedang berjalan")
                )
                scan_id = cur.lastrowid
                state["scan_id"] = scan_id
        finally:
            c.close()
        if not shutil.which("nmap"):
            raise RuntimeError(
                "Nmap tidak ditemukan. Install: apt install -y nmap"
            )

        nets = scan_networks()

        if not nets:
            raise RuntimeError(
                "Tidak menemukan interface LAN private. "
                "Pastikan server mempunyai IP LAN seperti 192.168.x.x."
            )

        state["message"] = (
            "Discovery LAN: "
            + ", ".join(
                f'{x["interface"]}={x["network"]}'
                for x in nets
            )
        )
        state["stage"] = "discovery"

        all_devices = {}
        discovery_errors = []

        # Nmap discovery per physical/private interface.
        for item in nets:
            discovered, error = nmap_discover(item["network"])

            if error:
                discovery_errors.append(
                    f'{item["interface"]}: {error}'
                )

            for device in discovered:
                all_devices[device["ip"]] = device

        # ARP is used as a second source. This catches devices which
        # appeared in the kernel neighbour table even if Nmap output
        # was unusual.
        arp = arp_neighbors()

        for ip, n in arp.items():
            try:
                addr = ipaddress.ip_address(ip)
                if addr.version != 4:
                    continue
            except Exception:
                continue

            if ip not in all_devices:
                all_devices[ip] = {
                    "ip": ip,
                    "hostname": "",
                    "mac": n.get("mac", ""),
                    "vendor": "",
                    "latency_ms": None,
                }
            else:
                if not all_devices[ip].get("mac"):
                    all_devices[ip]["mac"] = n.get("mac", "")

        # Never inventory our own local interface addresses.
        local_ips = {x["ip"] for x in interfaces()}
        for ip in list(all_devices.keys()):
            if ip in local_ips:
                del all_devices[ip]

        targets = sorted(
            all_devices.values(),
            key=lambda x: tuple(
                int(part)
                for part in x["ip"].split(".")
            ),
        )

        state["total"] = len(targets)
        state["discovered"] = len(targets)
        state["message"] = (
            f"Discovery selesai — {len(targets)} device ditemukan. "
            "Mengambil detail..."
        )

        # If discovery found nothing, still save a scan history entry.
        if not targets:
            fin = now()

            c = db()
            try:
                with c.cursor() as cur:
                    cur.execute(
                        "UPDATE scans SET finished=%s, discovered=0, message=%s WHERE id=%s",
                        (fin, "Discovery selesai: 0 device", scan_id)
                    )
            finally:
                c.close()

            state.update(
                running=False,
                finished=fin,
                message="Discovery selesai — 0 device online",
                stage="done",
                progress=0,
                total=0,
            )
            return

        # Mark all previously known devices offline first.
        c = db()
        try:
            with c.cursor() as cur:
                cur.execute(
                    "UPDATE devices SET online=0"
                )
                cur.execute(
                    "UPDATE device_identity SET online=0"
                )
        finally:
            c.close()

        state["stage"] = "fingerprint"
        state["progress"] = 0

        found = 0

        with ThreadPoolExecutor(
            max_workers=max(1, WORKERS)
        ) as executor:

            futures = {
                executor.submit(
                    inspect_device,
                    item,
                    arp,
                ): item["ip"]
                for item in targets
            }

            for index, future in enumerate(
                as_completed(futures),
                start=1,
            ):
                ip = futures[future]
                state["progress"] = index
                state["message"] = (
                    f"Detail {index}/{len(targets)} — {ip}"
                )

                try:
                    device = future.result()

                    if device:
                        save_device(device, scan_id)
                        found += 1

                except Exception as exc:
                    # One problematic device must never stop the whole scan.
                    print(
                        f"[DEVICE ERROR] {ip}: {exc}",
                        flush=True,
                    )

        fin = now()

        msg = (
            f"Scan selesai — {found} device online"
        )

        if discovery_errors:
            msg += " | " + " ; ".join(discovery_errors)

        c = db()

        try:
            with c.cursor() as cur:
                cur.execute(
                    "UPDATE scans SET finished=%s, discovered=%s, message=%s WHERE id=%s",
                    (fin, found, msg, scan_id),
                )
        finally:
            c.close()

        state.update(
            running=False,
            finished=fin,
            message=msg,
            stage="done",
            progress=len(targets),
            total=len(targets),
            discovered=found,
        )

    except Exception as exc:
        error = str(exc)

        print(
            "[SCAN ERROR]",
            error,
            flush=True,
        )

        state.update(
            running=False,
            finished=now(),
            message="ERROR: " + error,
            stage="error",
            error=error,
        )

    finally:
        scan_lock.release()


# =========================================================
# EXCEL EXPORT
# =========================================================

def parse_ports_value(value):
    if isinstance(value, list):
        return value
    try:
        return json.loads(value or "[]")
    except Exception:
        return []


def filtered_devices(devices, q="", status="all", dtype="all"):
    q = (q or "").strip().lower()
    result = []

    for d in devices:
        ports = parse_ports_value(d.get("ports"))

        hay = " ".join([
            str(d.get("ip") or ""),
            str(d.get("hostname") or ""),
            str(d.get("mac") or ""),
            str(d.get("vendor") or ""),
            str(d.get("os_name") or ""),
            str(d.get("device_type") or ""),
            " ".join(str(x) for x in ports),
        ]).lower()

        if q and q not in hay:
            continue

        online = bool(d.get("online"))

        if status == "online" and not online:
            continue
        if status == "offline" and online:
            continue

        if dtype != "all" and (d.get("device_type") or "Unknown") != dtype:
            continue

        result.append(d)

    return result


def normalized_os_name(value):
    s = (value or "").strip()
    if not s:
        return "Unknown"

    low = s.lower()

    # Normalize common Nmap variants into useful dashboard groups.
    groups = [
        ("Windows", ("windows", "microsoft")),
        ("Linux", ("linux", "ubuntu", "debian", "centos", "red hat", "unix")),
        ("macOS / Apple", ("mac os", "macos", "darwin", "apple")),
        ("Android", ("android",)),
        ("iOS / Apple", ("ios", "iphone", "ipad")),
        ("FreeBSD / BSD", ("freebsd", "openbsd", "netbsd", "bsd")),
        ("Network OS", ("routeros", "junos", "ios-xe", "cisco ios")),
    ]

    for label, words in groups:
        if any(w in low for w in words):
            return label

    return "Unknown"


def build_os_summary(devices):
    counts = {}
    for d in devices:
        key = normalized_os_name(d.get("os_name"))
        counts[key] = counts.get(key, 0) + 1

    return sorted(
        counts.items(),
        key=lambda x: (-x[1], x[0].lower())
    )


def build_type_summary(devices):
    counts = {}
    for d in devices:
        key = d.get("device_type") or "Unknown"
        counts[key] = counts.get(key, 0) + 1

    return sorted(
        counts.items(),
        key=lambda x: (-x[1], x[0].lower())
    )


def excel_header(ws, row, columns):
    fill = PatternFill("solid", fgColor="173A5E")
    font = Font(color="FFFFFF", bold=True)
    side = Side(style="thin", color="2A4A66")

    for col, title in enumerate(columns, 1):
        cell = ws.cell(row=row, column=col, value=title)
        cell.fill = fill
        cell.font = font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = Border(bottom=side)

    ws.freeze_panes = f"A{row + 1}"
    ws.auto_filter.ref = (
        f"A{row}:{get_column_letter(len(columns))}{row}"
    )


def autosize_sheet(ws, max_width=42):
    for column_cells in ws.columns:
        length = 0
        col_letter = get_column_letter(column_cells[0].column)

        for cell in column_cells:
            try:
                value = "" if cell.value is None else str(cell.value)
                length = max(length, len(value))
            except Exception:
                pass

        ws.column_dimensions[col_letter].width = min(
            max(length + 2, 11),
            max_width,
        )


def add_title(ws, title, subtitle=""):
    ws["A1"] = title
    ws["A1"].font = Font(size=18, bold=True, color="173A5E")

    if subtitle:
        ws["A2"] = subtitle
        ws["A2"].font = Font(size=10, color="5E7890")

    ws.merge_cells(
        start_row=1,
        start_column=1,
        end_row=1,
        end_column=max(1, 8),
    )


def create_excel_export(
    devices, scan_history, local_interfaces, q="", status="all", dtype="all",
    identities=None, ip_history=None, changes=None, scan_results=None
):
    if Workbook is None:
        raise RuntimeError(
            "openpyxl belum terpasang. Jalankan: "
            "python -m pip install openpyxl"
        )

    selected = filtered_devices(
        devices,
        q=q,
        status=status,
        dtype=dtype,
    )

    wb = Workbook()

    # -----------------------------------------------------
    # Sheet 1: Dashboard / Summary
    # -----------------------------------------------------
    ws = wb.active
    ws.title = "Dashboard"

    add_title(
        ws,
        "Network Inventory Dashboard",
        f"Export: {now()} | Filter status={status} | type={dtype} | search={q or '-'}",
    )

    online = sum(1 for d in devices if d.get("online"))
    offline = len(devices) - online

    summary = [
        ("TOTAL DEVICE", len(devices)),
        ("ONLINE", online),
        ("OFFLINE / LAST KNOWN", offline),
        ("FILTERED DEVICE", len(selected)),
        ("SERVER TIME", now()),
    ]

    row = 4
    for label, value in summary:
        ws.cell(row=row, column=1, value=label).font = Font(bold=True)
        ws.cell(row=row, column=2, value=value)
        row += 1

    row += 1
    ws.cell(row=row, column=1, value="OS / PLATFORM SUMMARY").font = Font(
        size=13, bold=True, color="173A5E"
    )
    row += 1

    excel_header(ws, row, ["OS / PLATFORM", "JUMLAH"])
    for os_name, count in build_os_summary(devices):
        row += 1
        ws.cell(row=row, column=1, value=os_name)
        ws.cell(row=row, column=2, value=count)

    row += 2
    ws.cell(row=row, column=1, value="DEVICE TYPE SUMMARY").font = Font(
        size=13, bold=True, color="173A5E"
    )
    row += 1

    excel_header(ws, row, ["DEVICE TYPE", "JUMLAH"])
    for dtype_name, count in build_type_summary(devices):
        row += 1
        ws.cell(row=row, column=1, value=dtype_name)
        ws.cell(row=row, column=2, value=count)

    row += 2
    ws.cell(row=row, column=1, value="VENDOR → DEVICE TYPE").font = Font(size=13,bold=True,color="173A5E")
    row += 1
    excel_header(ws, row, ["VENDOR","DEVICE TYPE","JUMLAH"])
    for item in build_vendor_type_summary(devices):
        row += 1
        ws.cell(row=row,column=1,value=item["vendor"])
        ws.cell(row=row,column=2,value=item["device_type"])
        ws.cell(row=row,column=3,value=item["count"])

    row += 2
    ws.cell(row=row,column=1,value="VENDOR SUMMARY").font = Font(size=13,bold=True,color="173A5E")
    row += 1
    excel_header(ws,row,["VENDOR","JUMLAH DEVICE","DEVICE TYPES"])
    for item in build_vendor_summary(devices):
        row += 1
        type_txt="; ".join(f'{x["type"]} ({x["count"]})' for x in item["types"])
        ws.cell(row=row,column=1,value=item["vendor"])
        ws.cell(row=row,column=2,value=item["count"])
        ws.cell(row=row,column=3,value=type_txt)

    autosize_sheet(ws)

    # -----------------------------------------------------
    # Sheet 2: Device Inventory
    # -----------------------------------------------------
    ws = wb.create_sheet("Device Inventory")

    add_title(
        ws,
        "Device Inventory",
        f"Rows mengikuti filter dashboard saat export | {len(selected)} device",
    )

    columns = [
        "NO","STATUS","IP","HOSTNAME","MAC","VENDOR","OS",
        "OS CONFIDENCE","OS EVIDENCE","DEVICE TYPE","OPEN PORTS",
        "LATENCY MS","FIRST SEEN","LAST SEEN","SOURCE"
    ]

    excel_header(ws, 4, columns)

    for r, d in enumerate(selected, 5):
        ports = parse_ports_value(d.get("ports"))

        values = [
            r-4,
            "ONLINE" if d.get("online") else "OFFLINE",
            d.get("ip") or "",
            d.get("hostname") or "",
            d.get("mac") or "",
            d.get("vendor") or "",
            d.get("os_name") or "Unknown",
            d.get("os_confidence") or "LOW",
            d.get("os_evidence") or "",
            d.get("device_type") or "Unknown",
            ", ".join(str(x) for x in ports),
            d.get("latency_ms"),
            d.get("first_seen") or "",
            d.get("last_seen") or "",
            d.get("source") or "",
        ]

        for c, value in enumerate(values, 1):
            ws.cell(row=r, column=c, value=value)

    autosize_sheet(ws, 48)

    # -----------------------------------------------------
    # Sheet 3: OS Summary
    # -----------------------------------------------------
    ws = wb.create_sheet("OS Summary")

    add_title(
        ws,
        "OS / Platform Summary",
        "Jumlah device berdasarkan hasil OS fingerprint / normalized OS",
    )

    excel_header(ws, 4, ["OS / PLATFORM", "JUMLAH", "PERSENTASE"])

    total = len(devices)

    for r, (os_name, count) in enumerate(build_os_summary(devices), 5):
        ws.cell(row=r, column=1, value=os_name)
        ws.cell(row=r, column=2, value=count)
        ws.cell(
            row=r,
            column=3,
            value=(count / total) if total else 0,
        )
        ws.cell(row=r, column=3).number_format = "0.00%"

    autosize_sheet(ws)

    # -----------------------------------------------------
    # Sheet 4: Device Type Summary
    # -----------------------------------------------------
    ws = wb.create_sheet("Device Type")

    add_title(
        ws,
        "Device Type Summary",
        "Jumlah device berdasarkan klasifikasi inventory",
    )

    excel_header(ws, 4, ["DEVICE TYPE", "JUMLAH", "PERSENTASE"])

    for r, (name, count) in enumerate(build_type_summary(devices), 5):
        ws.cell(row=r, column=1, value=name)
        ws.cell(row=r, column=2, value=count)
        ws.cell(
            row=r,
            column=3,
            value=(count / len(devices)) if devices else 0,
        )
        ws.cell(row=r, column=3).number_format = "0.00%"

    autosize_sheet(ws)

    # -----------------------------------------------------
    # Sheet 5: Vendor → Device Type
    # -----------------------------------------------------
    ws = wb.create_sheet("Vendor Type")
    add_title(ws,"Vendor → Device Type","Klasifikasi berdasarkan vendor + port/service/raw data")
    excel_header(ws,4,["VENDOR","DEVICE TYPE","JUMLAH"])
    for r,item in enumerate(build_vendor_type_summary(devices),5):
        ws.cell(r,1,item["vendor"]); ws.cell(r,2,item["device_type"]); ws.cell(r,3,item["count"])
    autosize_sheet(ws,55)

    # -----------------------------------------------------
    # Sheet 6: Vendor Summary
    # -----------------------------------------------------
    ws = wb.create_sheet("Vendor Summary")
    add_title(ws,"Vendor Summary","Vendor terpisah dari OS / Platform; type ditentukan dari evidence")
    excel_header(ws,4,["VENDOR","JUMLAH DEVICE","DEVICE TYPES"])
    for r,item in enumerate(build_vendor_summary(devices),5):
        type_txt="; ".join(f'{x["type"]} ({x["count"]})' for x in item["types"])
        ws.cell(r,1,item["vendor"]); ws.cell(r,2,item["count"]); ws.cell(r,3,type_txt)
    autosize_sheet(ws,70)

    # -----------------------------------------------------
    # Sheet 7: MAC Identity
    # -----------------------------------------------------
    ws = wb.create_sheet("Identity")
    add_title(ws,"MAC Device Identity","MAC sebagai identity; current/previous IP dan perubahan")
    excel_header(ws,4,["MAC","CURRENT IP","PREVIOUS IP","HOSTNAME","VENDOR","OS",
                        "OS CONFIDENCE","DEVICE TYPE","FIRST SEEN","LAST SEEN",
                        "ONLINE","IP CHANGE COUNT","LAST SCAN ID"])
    for r,x in enumerate(identities or [],5):
        vals=[x.get("mac") or "",x.get("current_ip") or "",x.get("previous_ip") or "",
              x.get("hostname") or "",x.get("vendor") or "",x.get("os_name") or "Unknown",
              x.get("os_confidence") or "LOW",x.get("device_type") or "Unknown",
              x.get("first_seen") or "",x.get("last_seen") or "",
              "ONLINE" if x.get("online") else "OFFLINE",x.get("ip_change_count") or 0,
              x.get("last_scan_id")]
        for c,v in enumerate(vals,1): ws.cell(r,c,v)
    autosize_sheet(ws,48)

    # -----------------------------------------------------
    # Sheet 7: IP History
    # -----------------------------------------------------
    ws = wb.create_sheet("IP History")
    add_title(ws,"MAC → IP History","Riwayat seluruh IP yang pernah dipakai oleh setiap MAC")
    excel_header(ws,4,["MAC","IP","FIRST SEEN","LAST SEEN","CURRENT","CHANGE COUNT","LAST SCAN ID"])
    for r,x in enumerate(ip_history or [],5):
        vals=[x.get("mac") or "",x.get("ip") or "",x.get("first_seen") or "",
              x.get("last_seen") or "","YES" if x.get("is_current") else "NO",
              x.get("change_count") or 0,x.get("last_scan_id")]
        for c,v in enumerate(vals,1): ws.cell(r,c,v)
    autosize_sheet(ws,42)

    # -----------------------------------------------------
    # Sheet 8: Identity Changes
    # -----------------------------------------------------
    ws = wb.create_sheet("Identity Changes")
    add_title(ws,"Identity Changes","IP_CHANGED / MAC_CHANGED / NEW_DEVICE")
    excel_header(ws,4,["ID","SCAN ID","CHANGE TYPE","MAC","OLD MAC","NEW MAC",
                        "OLD IP","NEW IP","DETECTED AT","DETAILS"])
    for r,x in enumerate(changes or [],5):
        vals=[x.get("id"),x.get("scan_id"),x.get("change_type") or "",
              x.get("mac") or "",x.get("old_mac") or "",x.get("new_mac") or "",
              x.get("old_ip") or "",x.get("new_ip") or "",x.get("detected_at") or "",
              x.get("details") or ""]
        for c,v in enumerate(vals,1): ws.cell(r,c,v)
    autosize_sheet(ws,80)

    # -----------------------------------------------------
    # Sheet 9: Scan Results
    # -----------------------------------------------------
    ws = wb.create_sheet("Scan Results")
    add_title(ws,"Scan Results","Immutable device result setiap sesi scan")
    excel_header(ws,4,["ID","SCAN ID","IP","MAC","HOSTNAME","VENDOR","OS","OS CONFIDENCE",
                        "OS EVIDENCE","DEVICE TYPE","OPEN PORTS","SOURCE","ONLINE",
                        "LATENCY MS","SCAN TIME"])
    for r,x in enumerate(scan_results or [],5):
        ports=parse_ports_value(x.get("ports"))
        vals=[x.get("id"),x.get("scan_id"),x.get("ip") or "",x.get("mac") or "",
              x.get("hostname") or "",x.get("vendor") or "",x.get("os_name") or "Unknown",
              x.get("os_confidence") or "LOW",x.get("os_evidence") or "",
              x.get("device_type") or "Unknown",", ".join(str(p) for p in ports),
              x.get("source") or "","ONLINE" if x.get("online") else "OFFLINE",
              x.get("latency_ms"),x.get("scan_time") or ""]
        for c,v in enumerate(vals,1): ws.cell(r,c,v)
    autosize_sheet(ws,60)

    # -----------------------------------------------------
    # Sheet 10: Local Interfaces
    # -----------------------------------------------------
    ws = wb.create_sheet("Local Interfaces")

    add_title(
        ws,
        "Local Network Interfaces",
        "Interface pada mesin dashboard yang digunakan untuk discovery",
    )

    excel_header(
        ws,
        4,
        ["INTERFACE", "IP ADDRESS", "NETMASK", "NETWORK"],
    )

    for r, x in enumerate(local_interfaces, 5):
        ws.cell(row=r, column=1, value=x.get("interface") or "")
        ws.cell(row=r, column=2, value=x.get("ip") or "")
        ws.cell(row=r, column=3, value=x.get("netmask") or "")
        ws.cell(row=r, column=4, value=x.get("network") or "")

    autosize_sheet(ws)

    # -----------------------------------------------------
    # Sheet 6: Scan History
    # -----------------------------------------------------
    ws = wb.create_sheet("Scan History")

    add_title(
        ws,
        "Scan History",
        "Riwayat scan yang tersimpan di MariaDB",
    )

    excel_header(
        ws,
        4,
        ["ID", "STARTED", "FINISHED", "DISCOVERED", "MESSAGE"],
    )

    for r, x in enumerate(scan_history, 5):
        ws.cell(row=r, column=1, value=x.get("id"))
        ws.cell(row=r, column=2, value=x.get("started") or "")
        ws.cell(row=r, column=3, value=x.get("finished") or "")
        ws.cell(row=r, column=4, value=x.get("discovered") or 0)
        ws.cell(row=r, column=5, value=x.get("message") or "")

    autosize_sheet(ws, 80)

    # Workbook metadata.
    wb.properties.title = "Network Inventory Dashboard"
    wb.properties.subject = "LAN Network Inventory"
    wb.properties.creator = "Network Inventory Dashboard"

    output = BytesIO()
    wb.save(output)
    output.seek(0)

    return output


# =========================================================
# API
# =========================================================

@app.get("/")
def home():
    return render_template_string(HTML)


@app.get("/api/status")
def api_status():
    try:
        c = db()

        try:
            with c.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM devices
                    ORDER BY online DESC, INET_ATON(ip)
                    """
                )
                devices = cur.fetchall()

                for d in devices:
                    try:
                        d["ports"] = json.loads(
                            d.get("ports") or "[]"
                        )
                    except Exception:
                        d["ports"] = []

                devices = repair_device_fingerprint_fields(devices)

                cur.execute(
                    """
                    SELECT *
                    FROM scans
                    ORDER BY id DESC
                    LIMIT 20
                    """
                )
                history = cur.fetchall()
        finally:
            c.close()

        types = {}

        for d in devices:
            t = d.get("device_type") or "Unknown"
            types[t] = types.get(t, 0) + 1

        os_summary = [
            {
                "os": name,
                "count": count,
                "percentage": round(
                    (count / len(devices) * 100), 2
                ) if devices else 0,
            }
            for name, count in build_os_summary(devices)
        ]

        type_summary = [
            {
                "type": name,
                "count": count,
                "percentage": round(
                    (count / len(devices) * 100), 2
                ) if devices else 0,
            }
            for name, count in build_type_summary(devices)
        ]

        vendor_type_summary = build_vendor_type_summary(devices)
        vendor_summary = build_vendor_summary(devices)

        with db() as c2:
            with c2.cursor() as cur2:
                cur2.execute("""
                    SELECT mac,current_ip,previous_ip,hostname,vendor,os_name,os_confidence,
                           device_type,first_seen,last_seen,online,ip_change_count,last_scan_id
                    FROM device_identity
                    ORDER BY online DESC,last_seen DESC,mac
                    LIMIT 1000
                """)
                identities = cur2.fetchall()
                cur2.execute("""
                    SELECT id,scan_id,change_type,mac,old_mac,new_mac,old_ip,new_ip,detected_at,details
                    FROM device_changes
                    ORDER BY id DESC
                    LIMIT 100
                """)
                changes = cur2.fetchall()
                cur2.execute("""
                    SELECT COUNT(*) AS total FROM scan_results
                """)
                scan_result_count = cur2.fetchone()["total"]

        identity_stats = {
            "total": len(identities),
            "online": sum(1 for x in identities if x.get("online")),
            "offline": sum(1 for x in identities if not x.get("online")),
            "ip_changed": sum(1 for x in changes if x.get("change_type") == "IP_CHANGED"),
            "mac_changed": sum(1 for x in changes if x.get("change_type") == "MAC_CHANGED"),
            "new_devices": sum(1 for x in changes if x.get("change_type") == "NEW_DEVICE"),
            "scan_results": scan_result_count,
        }

        return jsonify({
            "ok": True,
            "server_time": now(),
            "local_hostname": socket.gethostname(),
            "platform": platform.platform(),
            "interfaces": interfaces(),
            "devices": devices,
            "history": history,
            "stats": {
                "total": len(devices),
                "online": sum(
                    1 for d in devices
                    if d.get("online")
                ),
                "offline": sum(
                    1 for d in devices
                    if not d.get("online")
                ),
                "types": types,
                "type_summary": type_summary,
                "os_summary": os_summary,
                "vendor_type_summary": vendor_type_summary,
                "vendor_summary": vendor_summary,
            },
            "scan": state,
            "identities": identities,
            "identity_changes": changes,
            "identity_stats": identity_stats,
            "vendor_type_summary": vendor_type_summary,
            "vendor_summary": vendor_summary,
            "database": {
                "engine": "MariaDB/MySQL",
                "host": DB_HOST,
                "name": DB_NAME,
            },
        })

    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": str(exc),
            "database": {
                "engine": "MariaDB/MySQL",
                "host": DB_HOST,
                "name": DB_NAME,
            },
        }), 500


@app.post("/api/scan")
def api_scan():
    if state["running"]:
        return jsonify({
            "ok": False,
            "message": "Scan sedang berjalan",
        }), 409

    threading.Thread(
        target=do_scan,
        daemon=True,
    ).start()

    return jsonify({
        "ok": True,
        "message": "Scan dimulai",
    })


@app.get("/api/export.xlsx")
def api_export_xlsx():
    try:
        c = db()

        try:
            with c.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM devices
                    ORDER BY online DESC, INET_ATON(ip)
                    """
                )
                devices = cur.fetchall()

                cur.execute(
                    """
                    SELECT *
                    FROM scans
                    ORDER BY id DESC
                    LIMIT 1000
                    """
                )
                history = cur.fetchall()

                cur.execute("""SELECT mac,current_ip,previous_ip,hostname,vendor,os_name,os_confidence,
                    device_type,first_seen,last_seen,online,ip_change_count,last_scan_id
                    FROM device_identity ORDER BY online DESC,last_seen DESC,mac LIMIT 10000""")
                identities = cur.fetchall()

                cur.execute("""SELECT mac,ip,first_seen,last_seen,is_current,change_count,last_scan_id
                    FROM device_ip_history ORDER BY mac,id LIMIT 50000""")
                ip_history = cur.fetchall()

                cur.execute("""SELECT id,scan_id,change_type,mac,old_mac,new_mac,old_ip,new_ip,
                    detected_at,details FROM device_changes ORDER BY id DESC LIMIT 50000""")
                changes = cur.fetchall()

                cur.execute("""SELECT id,scan_id,ip,mac,hostname,vendor,os_name,os_confidence,
                    os_evidence,device_type,ports,source,online,latency_ms,scan_time
                    FROM scan_results ORDER BY id DESC LIMIT 100000""")
                scan_results = cur.fetchall()
        finally:
            c.close()

        devices = repair_device_fingerprint_fields(devices)

        q = request.args.get("q", "")
        status = request.args.get("status", "all")
        dtype = request.args.get("type", "all")

        output = create_excel_export(
            devices,
            history,
            interfaces(),
            q=q,
            status=status,
            dtype=dtype,
            identities=identities,
            ip_history=ip_history,
            changes=changes,
            scan_results=scan_results,
        )

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        return send_file(
            output,
            mimetype=(
                "application/vnd.openxmlformats-officedocument."
                "spreadsheetml.sheet"
            ),
            as_attachment=True,
            download_name=f"network_inventory_{stamp}.xlsx",
        )

    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": str(exc),
        }), 500


@app.get("/api/device/<path:ip>")
def api_device(ip):
    try:
        c = db()

        try:
            with c.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM devices
                    WHERE ip=%s
                    """,
                    (ip,),
                )
                device = cur.fetchone()
        finally:
            c.close()

        if not device:
            return jsonify({
                "ok": False,
                "message": "Device tidak ditemukan",
            }), 404

        try:
            device["ports"] = json.loads(
                device.get("ports") or "[]"
            )
        except Exception:
            device["ports"] = []

        try:
            device["raw"] = json.loads(
                device.get("raw_json") or "{}"
            )
        except Exception:
            device["raw"] = {}

        if not (device.get("os_name") or "").strip() or (device.get("os_name") or "").strip().lower() == "unknown":
            raw = device.get("raw") or {}
            inferred, confidence, evidence = infer_os(
                device.get("hostname") or raw.get("hostname") or "",
                device.get("ports") or raw.get("ports") or [],
                raw.get("os_name") or "",
                raw.get("services") or [],
                device.get("vendor") or raw.get("vendor") or "",
            )
            if inferred != "Unknown":
                device["os_name"] = inferred
                device["os_confidence"] = confidence
                device["os_evidence"] = evidence

        history = []
        changes = []
        if device.get("mac"):
            c2 = db()
            try:
                with c2.cursor() as cur2:
                    cur2.execute("""
                        SELECT mac,ip,first_seen,last_seen,is_current,change_count,last_scan_id
                        FROM device_ip_history
                        WHERE mac=%s ORDER BY id DESC
                    """, (device["mac"],))
                    history = cur2.fetchall()
                    cur2.execute("""
                        SELECT * FROM device_changes
                        WHERE mac=%s OR old_mac=%s OR new_mac=%s
                        ORDER BY id DESC LIMIT 100
                    """, (device["mac"],device["mac"],device["mac"]))
                    changes = cur2.fetchall()
            finally:
                c2.close()

        return jsonify({
            "ok": True,
            "device": device,
            "ip_history": history,
            "changes": changes,
        })

    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": str(exc),
        }), 500


# =========================================================
# DASHBOARD
# =========================================================

HTML = r"""
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Network Inventory Dashboard • FIXED</title>

<style>
:root{
 --bg:#050c16;
 --panel:#0b1828;
 --panel2:#0e2136;
 --line:#1e3852;
 --text:#edf6ff;
 --muted:#8fa8c0;
 --blue:#3da1ff;
 --green:#35d399;
 --red:#ff647d;
 --yellow:#ffc857;
}

*{box-sizing:border-box}

body{
 margin:0;
 color:var(--text);
 font:14px Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
 background:
 radial-gradient(circle at 10% 0,#173958 0,#081625 35%,#030811 75%);
 min-height:100vh;
}

.wrap{
 width:min(1700px,100%);
 margin:auto;
 padding:28px;
}

.top{
 display:flex;
 justify-content:space-between;
 align-items:center;
 gap:20px;
 margin-bottom:20px;
}

.brand{
 display:flex;
 gap:14px;
 align-items:center;
}

.logo{
 width:50px;
 height:50px;
 border-radius:16px;
 display:grid;
 place-items:center;
 background:linear-gradient(135deg,#168bff,#715df6);
 font-size:25px;
 box-shadow:0 14px 40px #1576c744;
}

h1{
 margin:0;
 font-size:26px;
 letter-spacing:-.5px;
}

.sub{
 color:var(--muted);
 font-size:12px;
 margin-top:4px;
}

button,input,select{
 color:#fff;
 background:#081725;
 border:1px solid var(--line);
 border-radius:11px;
 padding:11px 14px;
}

button{
 cursor:pointer;
 font-weight:800;
}

.primary{
 background:#237fd7;
 border-color:#3d9af0;
}

.primary:disabled{
 opacity:.55;
 cursor:not-allowed;
}

.grid{
 display:grid;
 grid-template-columns:repeat(4,1fr);
 gap:14px;
}

.card{
 background:#0a1828ed;
 border:1px solid var(--line);
 border-radius:17px;
 padding:18px;
 box-shadow:0 18px 65px #00000038;
}

.label{
 color:var(--muted);
 font-size:10px;
 text-transform:uppercase;
 letter-spacing:1px;
}

.metric{
 margin-top:7px;
 font-size:32px;
 font-weight:900;
}

.green{color:var(--green)}
.red{color:var(--red)}
.yellow{color:var(--yellow)}

section{margin-top:15px}

.bar{
 display:flex;
 gap:10px;
 align-items:center;
 flex-wrap:wrap;
}

.small{
 color:var(--muted);
 font-size:12px;
}

.notice{
 margin-top:12px;
 padding:12px;
 border-radius:12px;
 background:#0c2136;
 border:1px solid var(--line);
 color:#a9c3da;
 font-size:12px;
 line-height:1.8;
}

.progressrow{
 display:flex;
 align-items:center;
 gap:10px;
 margin-top:10px;
}

progress{
 width:280px;
 height:9px;
 accent-color:var(--blue);
}

.search{
 flex:1;
 min-width:250px;
 outline:none;
}

.tablewrap{
 overflow:auto;
 margin-top:12px;
 border-radius:12px;
}

table{
 width:100%;
 min-width:1250px;
 border-collapse:collapse;
}

th{
 padding:12px;
 text-align:left;
 color:#7894ae;
 border-bottom:1px solid var(--line);
 font-size:10px;
 text-transform:uppercase;
 letter-spacing:.8px;
 white-space:nowrap;
}

td{
 padding:12px;
 border-bottom:1px solid #172d42;
 font-size:12px;
 white-space:nowrap;
}

tbody tr:hover td{
 background:#102a43;
 cursor:pointer;
}

.ip,.mono{
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
}

.ip{color:#9bd1ff}

.pill{
 display:inline-flex;
 align-items:center;
 gap:6px;
 padding:5px 9px;
 border-radius:99px;
 background:#13283d;
 font-size:10px;
 font-weight:900;
}

.dot{
 width:7px;
 height:7px;
 border-radius:50%;
 background:var(--red);
}

.dot.on{
 background:var(--green);
 box-shadow:0 0 10px #35d399aa;
}

.kv{
 display:grid;
 grid-template-columns:repeat(3,1fr);
 gap:10px;
 margin-top:12px;
}

.kv div{
 padding:12px;
 border:1px solid var(--line);
 border-radius:12px;
 background:#0d2136;
}

.kv b{
 display:block;
 color:#7894ae;
 font-size:9px;
 text-transform:uppercase;
 margin-bottom:6px;
}

.modalbg{
 position:fixed;
 inset:0;
 z-index:20;
 display:none;
 align-items:center;
 justify-content:center;
 padding:18px;
 background:#000b;
 backdrop-filter:blur(8px);
}

.modal{
 width:min(1000px,100%);
 max-height:90vh;
 overflow:auto;
 background:#091827;
 border:1px solid #294862;
 border-radius:20px;
 padding:22px;
 box-shadow:0 30px 100px #000;
}

.close{
 float:right;
}

.osgrid{
 display:grid;
 grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
 gap:10px;
 margin-top:12px;
}

.oscard{
 padding:14px;
 border:1px solid var(--line);
 border-radius:13px;
 background:#0d2136;
}

.oscard .osname{
 color:#a9c3da;
 font-size:11px;
 font-weight:800;
 min-height:30px;
}

.oscard .oscount{
 margin-top:5px;
 font-size:25px;
 font-weight:900;
 color:#72c4ff;
}

.oscard .ospct{
 color:#7894ae;
 font-size:10px;
 margin-top:2px;
}

.pager{
 display:flex;
 align-items:center;
 justify-content:space-between;
 gap:10px;
 flex-wrap:wrap;
 margin-top:14px;
 padding-top:12px;
 border-top:1px solid var(--line);
}

.pager .pages{
 display:flex;
 gap:6px;
 align-items:center;
 flex-wrap:wrap;
}

.pager button{
 padding:7px 10px;
 min-width:38px;
}

.pager button.active{
 background:#237fd7;
 border-color:#3d9af0;
}

.exportbtn{
 background:#173a5e;
 border-color:#2d608c;
}


.vendor-section-head{
 cursor:pointer;
 user-select:none;
 padding:10px 12px;
 border-radius:11px;
 transition:background .18s ease,border-color .18s ease;
}

.vendor-section-head:hover{
 background:#102a43;
}

.vendor-section-arrow{
 display:inline-block;
 margin-left:7px;
 color:#72c4ff;
 font-size:11px;
 transition:transform .18s ease;
}

.vendor-section-arrow.closed{
 transform:rotate(-90deg);
}

.vendor-toolbar{
 display:flex;
 align-items:center;
 gap:10px;
 flex-wrap:wrap;
 margin-top:12px;
}

.vendor-select{
 min-width:320px;
 flex:1;
 max-width:520px;
}

.vendor-detail{
 margin-top:14px;
 border:1px solid #294862;
 border-radius:14px;
 background:#081725;
 overflow:hidden;
}

.vendor-detail-head{
 display:flex;
 justify-content:space-between;
 align-items:center;
 gap:12px;
 padding:14px 16px;
 border-bottom:1px solid var(--line);
 background:#0d2136;
}

.vendor-detail-title{
 font-weight:900;
 color:#edf6ff;
}

.vendor-detail-meta{
 color:#8fa8c0;
 font-size:11px;
}

.vendor-mini-grid{
 display:grid;
 grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
 gap:8px;
 padding:12px 14px;
 border-bottom:1px solid var(--line);
}

.vendor-mini{
 padding:10px 12px;
 border:1px solid var(--line);
 border-radius:10px;
 background:#0a1b2d;
 cursor:pointer;
}

.vendor-mini:hover,
.vendor-mini.active{
 background:#12304a;
 border-color:#3479a8;
}

.vendor-mini b{
 display:block;
 color:#72c4ff;
 font-size:18px;
 margin-top:3px;
}

.vendor-mini span{
 color:#9db4ca;
 font-size:10px;
}

.vendor-device-table{
 width:100%;
 min-width:1450px;
 border-collapse:collapse;
}

.vendor-device-table th,
.vendor-device-table td{
 padding:9px 10px;
 border-bottom:1px solid #172d42;
 font-size:11px;
 text-align:left;
 white-space:nowrap;
}

.vendor-device-table th{
 color:#7894ae;
 font-size:9px;
 text-transform:uppercase;
 letter-spacing:.7px;
}

.vendor-device-table tbody tr:hover td{
 background:#102a43;
 cursor:pointer;
}

.vendor-chip{
 display:inline-block;
 padding:4px 8px;
 border-radius:7px;
 background:#132d45;
 color:#bfe0fa;
 font-size:10px;
 font-weight:800;
 margin:2px;
}

.vendor-empty{
 padding:25px;
 text-align:center;
 color:#7892ac;
}

/* =====================================================
 * DEVICE IDENTITY — COLLAPSIBLE SECTION
 * ===================================================== */
.identity-section-head{
 cursor:pointer;
 user-select:none;
 padding:10px 12px;
 border-radius:11px;
 transition:background .18s ease,border-color .18s ease;
}

.identity-section-head:hover{
 background:#102a43;
}

.identity-section-arrow{
 display:inline-block;
 margin-left:7px;
 color:#72c4ff;
 font-size:11px;
 transition:transform .18s ease;
}

.identity-section-arrow.closed{
 transform:rotate(-90deg);
}

.identity-alert{color:#ffd166;font-weight:900}
.change-ip{color:#72c4ff;font-weight:900}
.change-mac{color:#ff8aa0;font-weight:900}
.change-new{color:#35d399;font-weight:900}
.identity-row:hover td{background:#102a43}

.badge{
 display:inline-block;
 padding:5px 9px;
 border-radius:8px;
 background:#132d45;
 color:#bfe0fa;
 margin:3px;
 font-family:ui-monospace,monospace;
 font-size:11px;
}

@media(max-width:950px){
 .grid{grid-template-columns:repeat(2,1fr)}
 .kv{grid-template-columns:repeat(2,1fr)}
}

@media(max-width:600px){
 .wrap{padding:14px}
 .grid{grid-template-columns:1fr}
 .kv{grid-template-columns:1fr}
 .top{align-items:flex-start}
}
</style>
</head>

<body>
<div class="wrap">

<div class="top">
 <div class="brand">
  <div class="logo">⌁</div>
  <div>
   <h1>Network Inventory</h1>
   <div class="sub">
    Automatic LAN discovery • IP / MAC / Hostname / Vendor / OS / Ports
   </div>
  </div>
 </div>

 <div class="bar">
  <button id="exportBtn" class="exportbtn" onclick="exportExcel()">
   ⇩ EXPORT EXCEL
  </button>
  <button id="scanBtn" class="primary" onclick="scan()">
   ↻ SCAN NETWORK
  </button>
 </div>
</div>

<div class="grid">

 <div class="card">
  <div class="label">Total Device</div>
  <div id="total" class="metric">0</div>
 </div>

 <div class="card">
  <div class="label">Online</div>
  <div id="on" class="metric green">0</div>
 </div>

 <div class="card">
  <div class="label">Offline / Last Known</div>
  <div id="off" class="metric red">0</div>
 </div>

 <div class="card">
  <div class="label">Server Time</div>
  <div id="tm" class="metric" style="font-size:17px;margin-top:14px">—</div>
 </div>

</div>

<section>
<div class="card">

 <div class="bar">
  <b>Discovery</b>
  <span id="msg" class="small">—</span>
 </div>

 <div class="notice">
  <b>Local host:</b> <span id="host">—</span>
  &nbsp; • &nbsp;
  <b>Platform:</b> <span id="plat">—</span>
  &nbsp; • &nbsp;
  <b>Interfaces:</b> <span id="ifs">—</span>
 </div>

 <div class="progressrow">
  <progress id="pg" value="0" max="1"></progress>
  <span id="pt" class="small"></span>
 </div>

</div>
</section>

<section>
<div class="card">

 <div class="bar">
  <b>OS / Platform</b>
  <span class="small">Jumlah device berdasarkan OS fingerprint</span>
 </div>

 <div id="osgrid" class="osgrid"></div>

</div>
</section>

<section>
<div class="card">

 <div class="bar vendor-section-head"
      onclick="toggleVendorSection()"
      title="Klik untuk buka / tutup halaman Vendor">
  <b>Vendor <span id="vendorSectionArrow" class="vendor-section-arrow">▼</span></b>
  <span class="small">Ringkasan vendor terpisah dari OS / Platform • klik vendor / pilih dropdown untuk membuka detail</span>
 </div>

 <div id="vendorSectionBody">

 <div class="vendor-toolbar" onclick="event.stopPropagation()">
  <select id="vendorSelect" class="vendor-select"
          onclick="vendorDropdownClicked(event)"
          onchange="vendorDropdownChanged()">
   <option value="">▼ Pilih Vendor</option>
  </select>
  <button onclick="clearVendorDetail()">✕ Clear</button>
 </div>

 <div id="vendorgrid" class="osgrid"></div>

 <div id="vendorDetail" class="vendor-detail" style="display:none">
   <div class="vendor-detail-head">
     <div>
       <div id="vendorDetailTitle" class="vendor-detail-title">Vendor</div>
       <div id="vendorDetailMeta" class="vendor-detail-meta"></div>
     </div>
     <button onclick="clearVendorDetail()">Tutup</button>
   </div>

   <div id="vendorMiniGrid" class="vendor-mini-grid"></div>

   <div class="tablewrap" style="margin-top:0">
    <table class="vendor-device-table">
     <thead><tr>
      <th>No</th><th>IP</th><th>Hostname</th><th>MAC</th><th>Vendor</th>
      <th>OS</th><th>Confidence</th><th>Device Type</th><th>Ports</th>
      <th>Services</th><th>Raw Data</th><th>Last Seen</th>
     </tr></thead>
     <tbody id="vendorDeviceRows"></tbody>
    </table>
   </div>
 </div>

 <div class="bar" style="margin-top:18px">
  <b>Vendor → Device Type Detail</b>
  <span class="small">Klik baris/vendor untuk melihat seluruh device vendor pada halaman yang sama</span>
 </div>

 <div class="tablewrap">
  <table style="min-width:850px">
   <thead><tr>
    <th>No</th><th>Vendor</th><th>Device Type</th><th>Jumlah</th><th>Persentase</th>
   </tr></thead>
   <tbody id="vendorTypeRows"></tbody>
  </table>
 </div> <!-- /vendorSectionBody -->

</div>
</section>

<section>
<div class="card">

 <div class="bar">
  <b>Device Inventory</b>
  <span id="cnt" class="small"></span>
 </div>

 <div class="bar" style="margin-top:12px">

  <input
   id="q"
   class="search"
   placeholder="Search IP, hostname, MAC, vendor, OS, device..."
   oninput="currentPage=1;render()"
  >

  <select id="st" onchange="currentPage=1;render()">
   <option value="all">All status</option>
   <option value="online">Online</option>
   <option value="offline">Offline</option>
  </select>

  <select id="ty" onchange="currentPage=1;render()">
   <option value="all">All types</option>
  </select>

 </div>

 <div class="tablewrap">

  <table>

   <thead>
    <tr>
     <th>No</th>
     <th>Status</th>
     <th>IP</th>
     <th>Hostname</th>
     <th>MAC</th>
     <th>Vendor</th>
     <th>OS</th>
     <th>Type</th>
     <th>Ports</th>
     <th>Latency</th>
     <th>Last Seen</th>
    </tr>
   </thead>

   <tbody id="rows"></tbody>

  </table>

 </div>

 <div class="pager">

  <div class="pages" id="pages"></div>

  <div class="bar">
   <span class="small">Rows / page</span>
   <select id="pageSize" onchange="pageSizeChanged()">
    <option value="15" selected>15</option>
    <option value="25">25</option>
    <option value="50">50</option>
    <option value="100">100</option>
    <option value="250">250</option>
   </select>
   <span id="pageInfo" class="small"></span>
  </div>

 </div>

</div>
</section>

<section>
<div class="card">

 <div class="bar identity-section-head"
      onclick="toggleIdentitySection()"
      title="Klik untuk buka / tutup Device Identity & Change Tracking">
  <b>
   Device Identity & Change Tracking
   <span id="identitySectionArrow" class="identity-section-arrow closed">▶</span>
  </b>
  <span class="small">MAC = identity • IP dapat berubah dan tetap dilacak • klik untuk buka / tutup</span>
 </div>

 <div id="identitySectionBody" style="display:none">

 <div class="osgrid" id="identityStats"></div>

 <div class="tablewrap">
  <table style="min-width:1150px">
   <thead><tr>
    <th>MAC Identity</th><th>Current IP</th><th>Previous IP</th><th>Hostname</th>
    <th>OS</th><th>Confidence</th><th>IP Changes</th><th>Last Seen</th>
   </tr></thead>
   <tbody id="identityRows"></tbody>
  </table>
 </div>

 <div style="margin-top:18px">
  <div class="bar"><b>Recent Changes</b><span class="small">IP / MAC / device identity events</span></div>
  <div class="tablewrap">
   <table style="min-width:1000px">
    <thead><tr><th>Type</th><th>MAC</th><th>Before</th><th>After</th><th>Detected</th><th>Details</th></tr></thead>
    <tbody id="changeRows"></tbody>
   </table>
  </div>
 </div>

 </div> <!-- /identitySectionBody -->

</div>
</section>

<section>
<div class="card">

 <div class="bar">
  <b>Local Network Interfaces</b>
  <span class="small">Interface yang dipakai untuk discovery</span>
 </div>

 <div id="locals" class="kv"></div>

</div>
</section>

</div>

<div id="mb" class="modalbg" onclick="if(event.target===this)closeM()">

 <div class="modal">

  <button class="close" onclick="closeM()">✕</button>

  <h2 id="dt">Device</h2>

  <div id="db"></div>

 </div>

</div>

<script>

let D={
 devices:[],
 interfaces:[],
 stats:{},
 scan:{}
};

let currentRows=[];
let currentPage=1;
let rowsPerPage=15;

const esc=x=>String(x??'').replace(
 /[&<>"']/g,
 m=>({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;',
  "'":'&#039;'
 }[m])
);

function load(){

 fetch('/api/status')
 .then(async r=>{
   const x=await r.json();

   if(!r.ok || x.ok===false){
     throw new Error(x.error || ('HTTP '+r.status));
   }

   return x;
 })
 .then(x=>{
   D=x;
   head();
   renderOS();
   renderVendors();
   renderVendorType();
   refreshTypeFilter();
   renderIdentity();
   render();
   locals();
 })
 .catch(err=>{
   document.querySelector('#msg').textContent=
    'API ERROR: '+err.message;
   console.error(err);
 });
}

function head(){

 document.querySelector('#total').textContent=
  D.stats.total || 0;

 document.querySelector('#on').textContent=
  D.stats.online || 0;

 document.querySelector('#off').textContent=
  D.stats.offline || 0;

 document.querySelector('#tm').textContent=
  D.server_time || '—';

 document.querySelector('#host').textContent=
  D.local_hostname || '—';

 document.querySelector('#plat').textContent=
  D.platform || '—';

 document.querySelector('#ifs').textContent=
  (D.interfaces||[])
   .map(x=>x.interface+': '+x.ip)
   .join(' • ') || '—';

 const s=D.scan||{};

 document.querySelector('#msg').textContent=
  s.message || '—';

 const p=document.querySelector('#pg');

 p.max=s.total || 1;
 p.value=s.progress || 0;

 document.querySelector('#pt').textContent=
  s.running
   ? `${s.progress||0} / ${s.total||0}`
   : '';

 const btn=document.querySelector('#scanBtn');

 btn.disabled=!!s.running;
 btn.textContent=
  s.running ? '⟳ SCANNING...' : '↻ SCAN NETWORK';
}

function getFilteredRows(){

 const q=
  document.querySelector('#q').value.toLowerCase().trim();

 const st=
  document.querySelector('#st').value;

 const ty=
  document.querySelector('#ty').value;

 return D.devices.filter(x=>{

   const hay=[
     x.ip,
     x.hostname,
     x.mac,
     x.vendor,
     x.os_name,
     x.device_type,
     (x.ports||[]).join(',')
   ].join(' ').toLowerCase();

   return (
    (!q || hay.includes(q)) &&
    (
      st==='all' ||
      (st==='online' && x.online) ||
      (st==='offline' && !x.online)
    ) &&
    (
      ty==='all' ||
      (x.device_type||'Unknown')===ty
    )
   );
 });
}

function render(){

 currentRows=getFilteredRows();

 const totalPages=
  Math.max(
   1,
   Math.ceil(currentRows.length/rowsPerPage)
  );

 if(currentPage>totalPages){
   currentPage=totalPages;
 }

 const start=(currentPage-1)*rowsPerPage;
 const arr=currentRows.slice(
   start,
   start+rowsPerPage
 );

 document.querySelector('#cnt').textContent=
  currentRows.length+' device';

 document.querySelector('#rows').innerHTML=
  arr.map((x,rowIndex)=>`

   <tr onclick="detail('${esc(x.ip)}')">

    <td class="mono" style="font-weight:800;color:#72c4ff">
     ${start+rowIndex+1}
    </td>

    <td>
     <span class="pill">
      <i class="dot ${x.online?'on':''}"></i>
      ${x.online?'ONLINE':'OFFLINE'}
     </span>
    </td>

    <td class="ip">${esc(x.ip)}</td>

    <td>${esc(x.hostname||'—')}</td>

    <td class="mono">${esc(x.mac||'—')}</td>

    <td>${esc(x.vendor||'—')}</td>

    <td>${esc(x.os_name||'Unknown')} <span class="small">${esc(x.os_confidence||'')}</span></td>

    <td>${esc(x.device_type||'Unknown')}</td>

    <td class="mono">
     ${
      x.ports?.length
       ? esc(x.ports.join(', '))
       : '—'
     }
    </td>

    <td>
     ${
      x.latency_ms!=null
       ? esc(x.latency_ms)+' ms'
       : '—'
     }
    </td>

    <td>${esc(x.last_seen||'—')}</td>

   </tr>

  `).join('') ||
  `
   <tr>
    <td colspan="11"
     style="text-align:center;padding:40px;color:#7892ac">
     Tidak ada data.
    </td>
   </tr>
  `;

 renderPager(totalPages);
}

function renderPager(totalPages){

 const pages=document.querySelector('#pages');

 const buttons=[];

 buttons.push(
  `<button onclick="goPage(${Math.max(1,currentPage-1)})"
   ${currentPage===1?'disabled':''}>‹</button>`
 );

 const windowSize=7;
 let from=Math.max(1,currentPage-3);
 let to=Math.min(totalPages,from+windowSize-1);

 if(to-from+1<windowSize){
   from=Math.max(1,to-windowSize+1);
 }

 for(let p=from;p<=to;p++){
   buttons.push(
    `<button class="${p===currentPage?'active':''}"
     onclick="goPage(${p})">${p}</button>`
   );
 }

 buttons.push(
  `<button onclick="goPage(${Math.min(totalPages,currentPage+1)})"
   ${currentPage===totalPages?'disabled':''}>›</button>`
 );

 pages.innerHTML=buttons.join('');

 const first=
  currentRows.length
   ? ((currentPage-1)*rowsPerPage)+1
   : 0;

 const last=
  Math.min(
   currentPage*rowsPerPage,
   currentRows.length
  );

 document.querySelector('#pageInfo').textContent=
  currentRows.length
   ? `${first}–${last} dari ${currentRows.length}`
   : '0 dari 0';
}

function goPage(page){
 currentPage=page;
 render();
 window.scrollTo({
  top:document.querySelector('#rows').getBoundingClientRect().top+
      window.scrollY-180,
  behavior:'smooth'
 });
}

function pageSizeChanged(){
 rowsPerPage=parseInt(
  document.querySelector('#pageSize').value,
  10
 )||50;

 currentPage=1;
 render();
}

function renderOS(){

 const box=document.querySelector('#osgrid');

 const data=
  (D.stats && D.stats.os_summary)
   ? D.stats.os_summary
   : [];

 box.innerHTML=
  data.map(x=>`
   <div class="oscard">
    <div class="osname">${esc(x.os)}</div>
    <div class="oscount">${esc(x.count)}</div>
    <div class="ospct">${esc(x.percentage)}%</div>
   </div>
  `).join('') ||
  `
   <div class="oscard">
    <div class="osname">Unknown</div>
    <div class="oscount">0</div>
    <div class="ospct">0%</div>
   </div>
  `;
}

function vendorKey(value){
 return String(value||'').trim() || 'Unknown Vendor';
}

/*
 * IMPORTANT:
 * Jangan masukkan nama Vendor/Device Type mentah ke onclick single-quote.
 * Vendor seperti "ABC's ..." akan memutus JavaScript inline onclick.
 * encodeURIComponent() membuat semua nama aman untuk dikirim ke handler.
 */
function jsArg(value){
 return encodeURIComponent(String(value??''));
}

function vendorSectionIsOpen(){
 const body=document.querySelector('#vendorSectionBody');
 return !!(body && body.style.display!=='none');
}

function setVendorSection(open, doScroll=false){
 const body=document.querySelector('#vendorSectionBody');
 const arrow=document.querySelector('#vendorSectionArrow');
 if(!body) return;

 body.style.display=open?'block':'none';
 if(arrow){
   arrow.classList.toggle('closed',!open);
   arrow.textContent=open?'▼':'▶';
 }

 if(open && doScroll){
   requestAnimationFrame(()=>{
     document.querySelector('.vendor-section-head')?.scrollIntoView({
       behavior:'smooth',
       block:'start'
     });
   });
 }
}

function toggleVendorSection(){
 setVendorSection(!vendorSectionIsOpen());
}

function openVendorSection(){
 setVendorSection(true,false);
}

function vendorDropdownClicked(event){
 openVendorSection();

 const select=event && event.currentTarget
   ? event.currentTarget
   : document.querySelector('#vendorSelect');

 if(!select) return;

 /*
  * onclick dipakai supaya dropdown memang punya handler klik.
  * Jika sudah ada vendor terpilih, langsung tampilkan halaman/detail.
  * Saat user memilih item baru, onchange akan memanggil handler lagi.
  */
 const vendor=select.value||'';
 if(vendor){
   openVendorDetail(vendor);
 }
}

function renderVendors(){
 const box=document.querySelector('#vendorgrid');
 const data=(D.stats&&D.stats.vendor_summary)||[];
 const select=document.querySelector('#vendorSelect');

 if(select){
   const current=select.value||'';
   select.innerHTML=
    `<option value="">▼ Pilih Vendor</option>`+
    data.map(x=>{
      const v=vendorKey(x.vendor);
      return `<option value="${esc(v)}">${esc(v)} — ${esc(x.count||0)} device</option>`;
    }).join('');
   if(data.some(x=>vendorKey(x.vendor)===current)) select.value=current;
 }

 box.innerHTML=data.map(x=>{
   const v=vendorKey(x.vendor);
   const types=(x.types||[]).map(y=>
      `<div style="margin-top:4px;font-size:11px;color:#9db4ca">${esc(y.type)} <b style="color:#72c4ff">${esc(y.count)}</b></div>`
   ).join('');
   return `<div class="oscard" onclick="openVendorDetail(decodeURIComponent('${jsArg(v)}'))" title="Klik untuk membuka Vendor → Device Type Detail" style="cursor:pointer">
      <div class="osname">${esc(v)}</div>
      <div class="oscount">${esc(x.count||0)}</div>
      <div class="ospct">device • CLICK FOR DETAIL</div>
      ${types}
   </div>`;
 }).join('') || `<div class="oscard"><div class="osname">Unknown Vendor</div><div class="oscount">0</div></div>`;
}

function vendorDropdownChanged(){
 openVendorSection();
 const select=document.querySelector('#vendorSelect');
 const vendor=select ? select.value : '';
 if(vendor) openVendorDetail(vendor);
 else clearVendorDetail();
}

function openVendorDetail(vendor, selectedType=''){
 openVendorSection();
 vendor=vendorKey(vendor);

 const detail=document.querySelector('#vendorDetail');
 const title=document.querySelector('#vendorDetailTitle');
 const meta=document.querySelector('#vendorDetailMeta');
 const mini=document.querySelector('#vendorMiniGrid');
 const rows=document.querySelector('#vendorDeviceRows');
 const select=document.querySelector('#vendorSelect');

 const devices=(D.devices||[]).filter(d=>vendorKey(d.vendor)===vendor);

 const typeCounts={};
 devices.forEach(d=>{
   const t=(d.device_type||'Unknown').trim()||'Unknown';
   typeCounts[t]=(typeCounts[t]||0)+1;
 });

 const typeList=Object.entries(typeCounts)
   .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));

 if(selectedType && !typeCounts[selectedType]) selectedType='';

 if(select){
   const exists=[...select.options].some(o=>o.value===vendor);
   if(exists) select.value=vendor;
 }

 title.textContent=vendor;
 meta.textContent=`${devices.length} device • Vendor → Device Type → device detail`;

 mini.innerHTML=typeList.map(([type,count])=>`
   <div class="vendor-mini ${selectedType===type?'active':''}"
        onclick="openVendorDetail(decodeURIComponent('${jsArg(vendor)}'),decodeURIComponent('${jsArg(type)}'))">
     <span>${esc(type)}</span>
     <b>${esc(count)}</b>
   </div>
 `).join('') || `<div class="vendor-empty">Tidak ada device untuk vendor ini.</div>`;

 let filtered=devices;
 if(selectedType){
   filtered=devices.filter(d=>
     ((d.device_type||'Unknown').trim()||'Unknown')===selectedType
   );
 }

 rows.innerHTML=filtered.map((d,i)=>{
   const ports=Array.isArray(d.ports)?d.ports:[];
   let raw={};
   try{ raw=JSON.parse(d.raw_json||'{}'); }catch(e){ raw={}; }

   const services=Array.isArray(raw.services)?raw.services:[];
   const serviceText=services.map(x=>{
     if(typeof x==='object') return `${x.port||''}/${x.text||''}`;
     return String(x);
   }).join(' • ');

   const rawText=JSON.stringify(raw);
   return `<tr onclick="detail('${esc(d.ip||'')}')" title="Klik untuk device detail">
     <td class="mono">${i+1}</td>
     <td class="ip">${esc(d.ip||'—')}</td>
     <td>${esc(d.hostname||'—')}</td>
     <td class="mono">${esc(d.mac||'—')}</td>
     <td>${esc(vendor)}</td>
     <td>${esc(d.os_name||'Unknown')} <span class="small">${esc(d.os_confidence||'')}</span></td>
     <td>${esc(d.os_confidence||'LOW')}</td>
     <td><span class="vendor-chip">${esc(d.device_type||'Unknown')}</span></td>
     <td class="mono">${esc(ports.join(', ')||'—')}</td>
     <td title="${esc(serviceText)}">${esc(serviceText||'—')}</td>
     <td class="mono" title="${esc(rawText)}">${esc(rawText.length>180?rawText.slice(0,180)+'…':rawText)||'—'}</td>
     <td>${esc(d.last_seen||'—')}</td>
   </tr>`;
 }).join('') || `<tr><td colspan="12" class="vendor-empty">Tidak ada device pada filter vendor/type ini.</td></tr>`;

 detail.style.display='block';

 /*
  * "Halaman capture/detail" harus langsung terlihat setelah
  * Vendor dipilih dari dropdown atau diklik dari kartu/tabel.
  */
 requestAnimationFrame(()=>{
   detail.scrollIntoView({
     behavior:'smooth',
     block:'start'
   });
 });
}

function clearVendorDetail(){
 const detail=document.querySelector('#vendorDetail');
 const select=document.querySelector('#vendorSelect');
 if(select) select.value='';
 if(detail) detail.style.display='none';
}

function renderVendorType(){
 const rows=(D.stats&&D.stats.vendor_type_summary)||[];
 const total=(D.stats&&D.stats.total)||0;
 document.querySelector('#vendorTypeRows').innerHTML=
  rows.map((x,i)=>{
   const pct=total?((x.count/total)*100).toFixed(2):'0.00';
   return `<tr onclick="openVendorDetail(decodeURIComponent('${jsArg(vendorKey(x.vendor))}'),decodeURIComponent('${jsArg(x.device_type||'Unknown')}'))" title="Klik untuk membuka detail vendor/type" style="cursor:pointer">
    <td class="mono" style="font-weight:800;color:#72c4ff">${i+1}</td>
    <td>${esc(x.vendor||'Unknown Vendor')}</td>
    <td>${esc(x.device_type||'Unknown')}</td>
    <td>${esc(x.count||0)}</td>
    <td>${pct}%</td>
   </tr>`;
  }).join('') ||
  `<tr><td colspan="5" style="text-align:center;padding:30px;color:#7892ac">Belum ada data vendor.</td></tr>`;
}

function refreshTypeFilter(){
 const select=document.querySelector('#ty');
 if(!select)return;
 const current=select.value||'all';
 const types=(D.stats&&D.stats.type_summary)?D.stats.type_summary.map(x=>x.type):[];
 const unique=[...new Set(types)].sort((a,b)=>String(a).localeCompare(String(b)));
 select.innerHTML=`<option value="all">All types</option>`+
   unique.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
 select.value=unique.includes(current)?current:'all';
}

function exportExcel(){

 const q=
  encodeURIComponent(
   document.querySelector('#q').value || ''
  );

 const status=
  encodeURIComponent(
   document.querySelector('#st').value || 'all'
  );

 const type=
  encodeURIComponent(
   document.querySelector('#ty').value || 'all'
  );

 const url=
  `/api/export.xlsx?q=${q}&status=${status}&type=${type}`;

 window.location.href=url;
}

function identitySectionIsOpen(){
 const body=document.querySelector('#identitySectionBody');
 return !!(body && body.style.display!=='none');
}

function setIdentitySection(open, doScroll=true){
 const body=document.querySelector('#identitySectionBody');
 const arrow=document.querySelector('#identitySectionArrow');
 if(!body) return;

 body.style.display=open?'block':'none';

 if(arrow){
   arrow.classList.toggle('closed',!open);
   arrow.textContent=open?'▼':'▶';
 }

 if(open && doScroll){
   requestAnimationFrame(()=>{
     document.querySelector('.identity-section-head')?.scrollIntoView({
       behavior:'smooth',
       block:'start'
     });
   });
 }
}

function toggleIdentitySection(){
 setIdentitySection(!identitySectionIsOpen(),true);
}

function openIdentitySection(){
 setIdentitySection(true,true);
}

function renderIdentity(){
 const st=D.identity_stats||{};
 const statsBox=document.querySelector('#identityStats');
 statsBox.innerHTML=`
  <div class="oscard"><div class="osname">MAC Identity</div><div class="oscount">${esc(st.total||0)}</div><div class="ospct">Known identity</div></div>
  <div class="oscard"><div class="osname">IP Changed</div><div class="oscount change-ip">${esc(st.ip_changed||0)}</div><div class="ospct">Detected events</div></div>
  <div class="oscard"><div class="osname">MAC Changed</div><div class="oscount change-mac">${esc(st.mac_changed||0)}</div><div class="ospct">Same IP, different MAC</div></div>
  <div class="oscard"><div class="osname">New Device</div><div class="oscount change-new">${esc(st.new_devices||0)}</div><div class="ospct">First seen MAC</div></div>
  <div class="oscard"><div class="osname">Scan Results</div><div class="oscount">${esc(st.scan_results||0)}</div><div class="ospct">Immutable rows</div></div>`;

 const ids=D.identities||[];
 document.querySelector('#identityRows').innerHTML=ids.map(x=>`<tr class="identity-row" onclick="detail('${esc(x.current_ip||'')}')">
  <td class="mono">${esc(x.mac||'—')}</td>
  <td class="ip">${esc(x.current_ip||'—')}</td>
  <td class="ip">${esc(x.previous_ip||'—')}</td>
  <td>${esc(x.hostname||'—')}</td>
  <td>${esc(x.os_name||'Unknown')}</td>
  <td>${esc(x.os_confidence||'LOW')}</td>
  <td>${esc(x.ip_change_count||0)}</td>
  <td>${esc(x.last_seen||'—')}</td>
 </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;padding:25px;color:#7892ac">Belum ada identity.</td></tr>`;

 const changes=D.identity_changes||[];
 document.querySelector('#changeRows').innerHTML=changes.map(x=>{
  const type=x.change_type||'';
  const before=x.old_ip||x.old_mac||'—';
  const after=x.new_ip||x.new_mac||'—';
  const cls=type==='IP_CHANGED'?'change-ip':(type==='MAC_CHANGED'?'change-mac':'change-new');
  return `<tr><td class="${cls}">${esc(type)}</td><td class="mono">${esc(x.mac||x.new_mac||'—')}</td><td>${esc(before)}</td><td>${esc(after)}</td><td>${esc(x.detected_at||'—')}</td><td>${esc(x.details||'—')}</td></tr>`;
 }).join('') || `<tr><td colspan="6" style="text-align:center;padding:25px;color:#7892ac">Belum ada perubahan.</td></tr>`;
}

function locals(){

 document.querySelector('#locals').innerHTML=
  (D.interfaces||[]).map(x=>`

   <div>
    <b>Interface</b>
    <span>${esc(x.interface)}</span>
   </div>

   <div>
    <b>IP Address</b>
    <span class="ip">${esc(x.ip)}</span>
   </div>

   <div>
    <b>Network</b>
    <span class="mono">${esc(x.network||'—')}</span>
   </div>

  `).join('');
}

function scan(){

 fetch('/api/scan',{
   method:'POST'
 })
 .then(async r=>{
   const x=await r.json();
   if(!r.ok || x.ok===false){
     throw new Error(x.message||x.error||('HTTP '+r.status));
   }
   return x;
 })
 .then(()=>{
   load();
 })
 .catch(err=>{
   document.querySelector('#msg').textContent=
    'SCAN ERROR: '+err.message;
   console.error(err);
 });
}

function detail(ip){

 fetch('/api/device/'+encodeURIComponent(ip))
 .then(r=>r.json())
 .then(x=>{

   if(!x.ok){
     throw new Error(x.error||'Device tidak ditemukan');
   }

   const d=x.device;

   const raw=d.raw||{};

   let serviceHtml='';

   if(
     Array.isArray(raw.services) &&
     raw.services.length
   ){
     serviceHtml=
      raw.services.map(s=>
       `<span class="badge">
        ${esc(s.port)} — ${esc(s.text)}
       </span>`
      ).join('');
   }

   document.querySelector('#dt').textContent=
    (d.hostname||d.ip)+' • '+d.ip;

   document.querySelector('#db').innerHTML=`

    <div class="kv">

     <div>
      <b>Status</b>
      <span>
       ${d.online?'🟢 ONLINE':'🔴 OFFLINE'}
      </span>
     </div>

     <div>
      <b>IP Address</b>
      <span class="ip">${esc(d.ip)}</span>
     </div>

     <div>
      <b>MAC Address</b>
      <span class="mono">${esc(d.mac||'—')}</span>
     </div>

     <div>
      <b>Hostname</b>
      <span>${esc(d.hostname||'—')}</span>
     </div>

     <div>
      <b>Vendor</b>
      <span>${esc(d.vendor||'Unknown')}</span>
     </div>

     <div>
      <b>Operating System</b>
      <span>${esc(d.os_name||'Unknown')}</span>
     </div>

     <div>
      <b>OS Confidence</b>
      <span>${esc(d.os_confidence||'LOW')}</span>
     </div>

     <div>
      <b>OS Evidence</b>
      <span>${esc(d.os_evidence||'—')}</span>
     </div>

     <div>
      <b>Device Type</b>
      <span>${esc(d.device_type||'Unknown')}</span>
     </div>

     <div>
      <b>Latency</b>
      <span>
       ${
        d.latency_ms!=null
         ? esc(d.latency_ms)+' ms'
         : '—'
       }
      </span>
     </div>

     <div>
      <b>Open Ports</b>
      <span class="mono">
       ${
        d.ports?.length
         ? esc(d.ports.join(', '))
         : 'None detected'
       }
      </span>
     </div>

     <div>
      <b>First Seen</b>
      <span>${esc(d.first_seen||'—')}</span>
     </div>

     <div>
      <b>Last Seen</b>
      <span>${esc(d.last_seen||'—')}</span>
     </div>

     <div>
      <b>Source</b>
      <span>${esc(d.source||'—')}</span>
     </div>

    </div>

    ${
     serviceHtml
      ? `
       <div style="margin-top:18px">
        <b>Detected Services</b>
        <div style="margin-top:8px">
         ${serviceHtml}
        </div>
       </div>
      `
      : ''
    }

    ${
      (x.ip_history||[]).length
      ? `<div style="margin-top:18px"><b>IP History — MAC Identity</b><div style="margin-top:8px">${x.ip_history.map(h=>`<span class="badge">${esc(h.ip)} • ${esc(h.first_seen)} → ${esc(h.last_seen)}${h.is_current?' • CURRENT':''}</span>`).join('')}</div></div>`
      : ''
    }

    ${
      (x.changes||[]).length
      ? `<div style="margin-top:18px"><b>Identity Changes</b><div style="margin-top:8px">${x.changes.map(ch=>`<span class="badge">${esc(ch.change_type)} • ${esc(ch.old_ip||ch.old_mac||'—')} → ${esc(ch.new_ip||ch.new_mac||'—')} • ${esc(ch.detected_at||'')}</span>`).join('')}</div></div>`
      : ''
    }

   `;

   document.querySelector('#mb').style.display='flex';
 })
 .catch(err=>{
   alert(err.message);
 });
}

function closeM(){
 document.querySelector('#mb').style.display='none';
}

load();

setInterval(load,5000);

</script>

</body>
</html>
"""


# =========================================================
# STARTUP
# =========================================================

if __name__ == "__main__":

    print("=" * 70)
    print(" NETWORK INVENTORY DASHBOARD")
    print("=" * 70)
    print(f"[WEB]      http://127.0.0.1:{PORT}")
    print(f"[DATABASE] MariaDB/MySQL {DB_HOST}:{DB_PORT}/{DB_NAME}")
    print("=" * 70)

    try:
        init_db()
        print("[DATABASE] OK")
    except Exception as exc:
        print("[DATABASE] ERROR:", exc)
        print("")
        print("Set these environment variables:")
        print("NETWORK_INVENTORY_DB_HOST")
        print("NETWORK_INVENTORY_DB_PORT")
        print("NETWORK_INVENTORY_DB_NAME")
        print("NETWORK_INVENTORY_DB_USER")
        print("NETWORK_INVENTORY_DB_PASSWORD")
        raise

    if shutil.which("nmap"):
        print("[NMAP]     OK")
    else:
        print("[NMAP]     NOT FOUND")

    print(f"[WEB]      Listening on {HOST}:{PORT}")
    print("=" * 70)

    app.run(
        host=HOST,
        port=PORT,
        debug=False,
        threaded=True,
    )
