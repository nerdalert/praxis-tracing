#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/evidence"
curl --fail --silent --show-error --max-time 150 -X POST -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4177/api/reset > "$ROOT/evidence/reset-baseline.json"
jq -e '.state.overlay.converged == true and .state.peer.signals.value == true and .probe.validResponse == true and (.state.pools[] | select(.id == "pool-a") | .activeRequests.value) == 0' \
  "$ROOT/evidence/reset-baseline.json" >/dev/null
echo 'fresh baseline, zero active work, peer signals restored, and route probe confirmed'
