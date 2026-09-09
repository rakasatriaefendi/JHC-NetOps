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
