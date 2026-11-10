#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="$ROOT/state/private"
mkdir -p "$PRIVATE"
RUN="$(cat "$ROOT/RUN_ID")"
if curl --silent --fail --max-time 3 http://127.0.0.1:4177/api/state -o "$PRIVATE/stop-ui-state.json"; then
  if [[ "$(jq -r '.runId // empty' "$PRIVATE/stop-ui-state.json")" == "$RUN" ]]; then
    "$ROOT/scripts/reset-baseline.sh"
  else
    echo 'port 4177 belongs to a different or unidentified UI; leaving it untouched' >&2
    exit 1
  fi
fi
stop_owned_pid() {
  local file=$1 needle=$2 pid args env
  [[ -f "$file" ]] || return 0
  pid=$(cat "$file")
  args=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if [[ -z "$args" ]]; then
    rm -f "$file"
    return 0
  fi
  env=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)
  if [[ "$args" == *"$needle"* ]] \
     && grep -Fxq "DEMO_RUN_PRIVATE=$PRIVATE" <<< "$env" \
     && grep -Fxq "DEMO_RUN_ID=$RUN" <<< "$env"; then
    kill -TERM "$pid"
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && { echo "owned process $pid did not stop" >&2; return 1; }
    rm -f "$file"
  else
    echo "refusing to stop PID $pid: ownership marker or command does not match $RUN" >&2
    return 1
  fi
}
stop_owned_pid "$PRIVATE/demo-ui.pid" "$ROOT/app/server.mjs"
for file in "$PRIVATE"/port-forward-*.pid; do
  [[ -f "$file" ]] || continue
  stop_owned_pid "$file" "kubectl"
done
echo 'run-owned UI and port-forward processes stopped; Kind clusters remain available'
