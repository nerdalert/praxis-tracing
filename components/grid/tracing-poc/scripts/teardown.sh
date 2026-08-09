#!/usr/bin/env bash
# Stop and remove the tracing POC Docker infrastructure.
#
# Usage:
#   ./tracing-poc/scripts/teardown.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../../../scripts/compose.sh"
POC_DIR="$(dirname "${SCRIPT_DIR}")"
COMPOSE_FILE="${POC_DIR}/docker/docker-compose.yaml"

echo "Stopping Jaeger + OTel Collector..."
compose -f "${COMPOSE_FILE}" down -v 2>/dev/null || true
echo "Done."
