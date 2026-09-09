#!/bin/bash
set -e

APP_DIR="/opt/network_inventory_dashboard"

echo "============================================================"
echo " INSTALL NETWORK INVENTORY AUTO RUN + AUTO RELOAD"
echo "============================================================"

echo "[1/5] Install inotify-tools..."
apt update
apt install -y inotify-tools

echo "[2/5] Cek Python venv..."
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    echo "ERROR: venv tidak ditemukan:"
    echo "       $APP_DIR/venv/bin/python"
    exit 1
fi

echo "[3/5] Buat AUTO RELOAD script..."

cat > "$APP_DIR/network_inventory_autoreload.sh" <<'SCRIPT'
#!/bin/bash
set -u

APP_DIR="/opt/network_inventory_dashboard"
APP_FILE="network_inventory.py"
PYTHON_BIN="$APP_DIR/venv/bin/python"

cd "$APP_DIR" || exit 1

command -v inotifywait >/dev/null 2>&1 || {
    echo "[AUTO-RELOAD] ERROR: inotifywait tidak ditemukan"
    exit 1
}

[ -x "$PYTHON_BIN" ] || {
    echo "[AUTO-RELOAD] ERROR: Python venv tidak ditemukan: $PYTHON_BIN"
    exit 1
}

child_pid=""

cleanup() {
    echo
    echo "[AUTO-RELOAD] STOP"

    if [ -n "${child_pid:-}" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        sleep 1
        kill -KILL "$child_pid" 2>/dev/null || true
    fi
}

trap cleanup INT TERM EXIT

echo "============================================================"
echo " NETWORK INVENTORY DASHBOARD"
echo " AUTO RUN + AUTO RELOAD"
echo "============================================================"
echo "[AUTO-RELOAD] APP : $APP_DIR/$APP_FILE"
echo "[AUTO-RELOAD] PORT: 5002"
echo "============================================================"

while true
do
    echo
    echo "[AUTO-RELOAD] START $(date '+%Y-%m-%d %H:%M:%S %Z')"

    "$PYTHON_BIN" "$APP_DIR/$APP_FILE" &
    child_pid=$!

    echo "[AUTO-RELOAD] PID  : $child_pid"

    while kill -0 "$child_pid" 2>/dev/null
    do
        EVENT=$(inotifywait \
            -q \
            -t 1 \
            -e close_write \
            -e moved_to \
            -e create \
            --format '%e|%f' \
            "$APP_DIR" 2>/dev/null || true)

        if [ -n "$EVENT" ]; then

            FILE="${EVENT#*|}"

            if [ "$FILE" = "$APP_FILE" ]; then

                echo
                echo "============================================================"
                echo "[AUTO-RELOAD] FILE BERUBAH"
                echo "[AUTO-RELOAD] FILE  : $FILE"
                echo "[AUTO-RELOAD] EVENT : $EVENT"
                echo "[AUTO-RELOAD] TIME  : $(date '+%Y-%m-%d %H:%M:%S %Z')"
                echo "[AUTO-RELOAD] RESTART APPLICATION..."
                echo "============================================================"

                kill -TERM "$child_pid" 2>/dev/null || true

                for i in $(seq 1 30)
                do
                    if ! kill -0 "$child_pid" 2>/dev/null
                    then
                        break
                    fi

                    sleep 0.2
                done

                kill -KILL "$child_pid" 2>/dev/null || true

                wait "$child_pid" 2>/dev/null || true

                child_pid=""

                sleep 1

                break
            fi
        fi
    done

    if [ -n "${child_pid:-}" ]; then

        if ! kill -0 "$child_pid" 2>/dev/null
        then
            wait "$child_pid" 2>/dev/null || true
            child_pid=""

            echo
            echo "[AUTO-RELOAD] Python berhenti/crash."
            echo "[AUTO-RELOAD] Restart 2 detik lagi..."

            sleep 2
        fi
    fi
done
SCRIPT

chmod +x "$APP_DIR/network_inventory_autoreload.sh"

echo "[4/5] Buat systemd service..."

cat > /etc/systemd/system/network-inventory.service <<'SERVICE'
[Unit]
Description=Network Inventory Dashboard - Auto Run + Auto Reload
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
Type=simple

User=root
Group=root

WorkingDirectory=/opt/network_inventory_dashboard

EnvironmentFile=-/opt/network_inventory_dashboard/.env

ExecStart=/opt/network_inventory_dashboard/network_inventory_autoreload.sh

Restart=always
RestartSec=2

KillMode=control-group

TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
SERVICE

echo "[5/5] Enable service..."

systemctl daemon-reload

systemctl enable network-inventory.service

systemctl restart network-inventory.service

echo
echo "============================================================"
echo " SELESAI"
echo "============================================================"

systemctl --no-pager --full status network-inventory.service

echo
echo "LOG REALTIME:"
echo "journalctl -u network-inventory.service -f"
echo
echo "STATUS:"
echo "systemctl status network-inventory.service"
echo
echo "URL:"
echo "http://192.168.1.78:5002"
echo "============================================================"
