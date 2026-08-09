#!/usr/bin/env bash
# Stop all tracing-related services: Praxis, mock backends, UI, Docker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
GRID_DIR="${ROOT_DIR}/components/grid"
POC_DIR="${GRID_DIR}/tracing-poc"
COMPOSE_FILE="${POC_DIR}/docker/docker-compose.yaml"
PID_DIR="/tmp"

echo "=== Teardown ==="
echo ""

stopped=0

for name in praxis-server mock-backend-a mock-backend-b; do
    pid_file="${PID_DIR}/${name}.pid"
    if [[ -f "$pid_file" ]]; then
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            echo "  Stopped $name (PID $pid)"
            stopped=$((stopped + 1))
        else
            echo "  $name (PID $pid) already dead"
        fi
        rm -f "$pid_file"
    fi
done

if [[ -f "${ROOT_DIR}/.ui.pid" ]]; then
    pid=$(cat "${ROOT_DIR}/.ui.pid")
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "  Stopped UI (PID $pid)"
        stopped=$((stopped + 1))
    else
        echo "  UI (PID $pid) already dead"
    fi
    rm -f "${ROOT_DIR}/.ui.pid"
fi

if [[ -f "$COMPOSE_FILE" ]]; then
    echo "  Stopping Docker containers..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null && {
        echo "  Docker containers stopped"
        stopped=$((stopped + 1))
    } || echo "  No Docker containers to stop"
fi

echo ""
if [[ $stopped -gt 0 ]]; then
    echo "Stopped $stopped service(s)."
else
    echo "No running services found."
fi
