#!/usr/bin/env bash
# Select Docker Compose by default, falling back to Podman Compose.
# Override with COMPOSE_RUNTIME, for example: podman compose.

if [[ -n "${COMPOSE_RUNTIME:-}" ]]; then
    read -r -a COMPOSE_CMD <<< "${COMPOSE_RUNTIME}"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(podman compose)
elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(podman-compose)
else
    echo "ERROR: neither Docker Compose nor Podman Compose is available" >&2
    exit 1
fi

compose() {
    "${COMPOSE_CMD[@]}" "$@"
}
