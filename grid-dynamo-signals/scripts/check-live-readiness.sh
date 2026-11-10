#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$(cat "$ROOT/RUN_ID")"
STATE="$ROOT/state/private/readiness-state.json"
mkdir -p "$(dirname "$STATE")"
chmod 700 "$(dirname "$STATE")"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  if curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4177/api/state -o "$STATE" 2>/dev/null && \
     jq -e --arg run "$RUN" '
       (.runId == $run) and
       (.identity.gridSourceStateSha256 | test("^[0-9a-f]{64}$")) and
       ([.pools[].id] | sort) == ["pool-a", "pool-b", "site-pool"] and
       all(.pools[]; .source.status == "LIVE" and .source.ageSeconds <= 5 and
         .modelReady.status == "LIVE" and .modelReady.value == 1 and
         .activeRequests.status == "LIVE" and .activeRequests.value == 0 and
         .profile == "dynamo-mocker-bounded-4-v1" and .capacity == 4) and
       .overlay.published.status == "LIVE" and .overlay.consumed.status == "LIVE" and
       .overlay.converged == true and .overlay.published.revision == .overlay.consumed.revision and
       .peer.status == "LIVE" and .peer.signals.status == "LIVE" and .peer.signals.value == true and
       (.gatewayMetrics.crossSite as $site |
         $site.status == "LIVE" and
         ($site.candidates | length) == 3 and
         ([ $site.candidates[].cluster ] | sort) == ["pool-a", "pool-b", "site-pool"] and
         all($site.candidates[];
           .scoreStatus == "LIVE" and .sampleAgeSeconds != null and
           (.sampleAgeSeconds <= (($site.freshnessWindowMs // 0) / 1000))))
     ' "$STATE" >/dev/null; then
    echo 'PASS: all three run-owned Dynamo Frontends are ready at zero active requests; live Grid and Gateway revisions match; all three Site Gateway candidates are fresh; peer signals are restored'
    exit 0
  fi
  sleep 2
done
echo 'FAIL: live demo did not reach a clean, source-locked baseline within 120 seconds; inspect the UI and evidence/runtime logs' >&2
exit 1
