#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="$ROOT/state/private"
EVIDENCE="$ROOT/evidence"
CONFIG="$PRIVATE/demo-config.json"
PIDFILE="$PRIVATE/demo-ui.pid"
mkdir -p "$EVIDENCE" "$PRIVATE"
chmod 700 "$PRIVATE"
[[ -f "$PRIVATE/hub.kubeconfig" && -f "$PRIVATE/site.kubeconfig" ]] || { echo 'run-owned kubeconfigs are missing; run ./scripts/provision-live.sh' >&2; exit 1; }
[[ -f "$CONFIG" ]] || { echo 'live config is missing; run ./scripts/provision-live.sh' >&2; exit 1; }
if [[ ! -x "$ROOT/node_modules/.bin/vite" ]]; then
  echo 'installing the locked UI dependencies from package-lock.json'
  (cd "$ROOT" && npm ci)
fi
(cd "$ROOT" && npm run build:ui)
"$(dirname "${BASH_SOURCE[0]}")/start-port-forwards.sh"
if [[ -f "$PIDFILE" ]]; then
  old_pid=$(cat "$PIDFILE")
  if kill -0 "$old_pid" 2>/dev/null && ps -p "$old_pid" -o args= | grep -Fq "$ROOT/app/server.mjs"; then
    existing=$(curl --silent --max-time 3 http://127.0.0.1:4177/api/state || true)
    if [[ "$(jq -r '.runId // empty' <<< "$existing")" == "$(cat "$ROOT/RUN_ID")" ]]; then
      echo 'run-owned demo UI is already live at http://127.0.0.1:4177'
      exit 0
    fi
    echo 'port 4177 is answering for a different run; leaving it untouched' >&2
    exit 1
  fi
fi
if ss -H -ltn 'sport = :4177' | grep -q .; then
  echo 'local port 4177 is already in use by an unverified process; leaving it untouched' >&2
  exit 1
fi
DEMO_RUN_PRIVATE="$PRIVATE" DEMO_RUN_ID="$(cat "$ROOT/RUN_ID")" \
  DEMO_CONFIG_PATH="$CONFIG" setsid node "$ROOT/app/server.mjs" \
  </dev/null > "$EVIDENCE/demo-ui-server.log" 2>&1 &
echo "$!" > "$PIDFILE"
for _ in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:4177/api/state > "$PRIVATE/ui-readiness.json"; then
    jq -e --arg run "$(cat "$ROOT/RUN_ID")" '.runId == $run' "$PRIVATE/ui-readiness.json" >/dev/null
    echo 'demo UI is live at http://127.0.0.1:4177'
    exit 0
  fi
  sleep 1
done
echo 'demo UI did not become ready; inspect evidence/demo-ui-server.log' >&2
exit 1
