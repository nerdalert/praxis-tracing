#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${PORT:-3001}"
JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"

cd "$PROJECT_DIR"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

echo "Starting Routing Observability UI..."
echo "  UI:     http://localhost:${PORT}"
echo "  Jaeger: ${JAEGER_URL}"
echo ""

PORT="$PORT" JAEGER_URL="$JAEGER_URL" node server.js
