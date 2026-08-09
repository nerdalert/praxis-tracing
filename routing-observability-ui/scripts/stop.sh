#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"

pid=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$pid" ]; then
  echo "Stopping UI server (PID $pid) on port $PORT..."
  kill "$pid" 2>/dev/null || true
  echo "Stopped."
else
  echo "No server running on port $PORT."
fi
