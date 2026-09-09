NETWORK INVENTORY DASHBOARD - FINAL

DATABASE
--------
MariaDB/MySQL. SQLite tidak digunakan.

INSTALL
-------
cd /opt/network_inventory_dashboard

apt update
apt install -y python3-full python3-venv python3-pip nmap mariadb-server

source venv/bin/activate
python -m pip install -r requirements.txt


MARIADB
-------
sudo mariadb

CREATE DATABASE IF NOT EXISTS network_inventory
CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'network_inventory'@'localhost'
IDENTIFIED BY 'PASSWORD_KUAT';

GRANT ALL PRIVILEGES ON network_inventory.*
TO 'network_inventory'@'localhost';

FLUSH PRIVILEGES;
EXIT;


RUN
---
export NETWORK_INVENTORY_DB_HOST=127.0.0.1
export NETWORK_INVENTORY_DB_PORT=3306
export NETWORK_INVENTORY_DB_NAME=network_inventory
export NETWORK_INVENTORY_DB_USER=network_inventory
export NETWORK_INVENTORY_DB_PASSWORD='GANTI_PASSWORD_KUAT'
export NETWORK_INVENTORY_PORT=5002

python network_inventory.py


DISCOVERY
---------
Scanner final menggunakan Nmap host discovery:

nmap -sn -PR --send-ip -T4 192.168.1.0/24

Interface loopback dan Docker bridge otomatis dilewati.
Contoh:
  eno2       192.168.1.78 -> scan 192.168.1.0/24
  lo         127.0.0.1    -> skip
  docker0    172.17.0.1   -> skip
  br-*       172.18.x.x   -> skip


DATA
----
IP
MAC
Hostname
MAC Vendor
Online/Offline
Latency
OS fingerprint
Device type
Open TCP ports
Detected services
First Seen
Last Seen
Scan history


IMPORTANT
---------
Untuk MAC address pada LAN Ethernet, jalankan aplikasi dengan permission
yang memungkinkan Nmap melakukan ARP discovery, biasanya root/sudo.

CPU/RAM/Disk/Serial Number/Windows User tidak dapat dijamin hanya dari
network scan. Data tersebut membutuhkan agent/WinRM/SSH/SNMP pada perangkat
yang memang diotorisasi.


TEST
----
curl http://127.0.0.1:5002/api/status

Kemudian:
http://IP-SERVER:5002
