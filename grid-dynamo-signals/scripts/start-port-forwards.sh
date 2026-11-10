#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="$ROOT/state/private"
EVIDENCE="$ROOT/evidence/runtime"
RUN="$(cat "$ROOT/RUN_ID")"
mkdir -p "$PRIVATE" "$EVIDENCE"
chmod 700 "$PRIVATE"

port_busy() { ss -H -ltn "sport = :$1" | grep -q .; }
start_forward() {
  local name=$1 kubeconfig=$2 context=$3 namespace=$4 target=$5 local_port=$6 remote_port=$7
  local pid_file="$PRIVATE/port-forward-$name.pid"
  if [[ -f "$pid_file" ]]; then
    local old_pid old_args
    old_pid=$(cat "$pid_file")
    old_args=$(ps -p "$old_pid" -o args= 2>/dev/null || true)
    old_env=""
    if [[ -r "/proc/$old_pid/environ" ]]; then
      old_env=$(tr '\0' '\n' < "/proc/$old_pid/environ" 2>/dev/null || true)
    fi
    if kill -0 "$old_pid" 2>/dev/null && grep -Fq -- "--kubeconfig $kubeconfig" <<< "$old_args" && grep -Fq 'port-forward' <<< "$old_args" \
       && grep -Fxq "DEMO_RUN_PRIVATE=$PRIVATE" <<< "$old_env" \
       && grep -Fxq "DEMO_RUN_ID=$RUN" <<< "$old_env"; then
      return
    fi
  fi
  if port_busy "$local_port"; then
    echo "local port $local_port is already owned by an unverified process; leaving it untouched" >&2
    exit 1
  fi
  # setsid keeps these run-owned forwards alive when this launcher shell exits.
  # With a background child that is not already a process-group leader, setsid
  # execs in place, so the PID file still names the kubectl process we can verify
  # and stop later.
  setsid env DEMO_RUN_PRIVATE="$PRIVATE" DEMO_RUN_ID="$RUN" \
    kubectl --kubeconfig "$kubeconfig" --context "$context" -n "$namespace" \
    port-forward --address 127.0.0.1 "$target" "$local_port:$remote_port" \
    </dev/null > "$EVIDENCE/port-forward-$name.log" 2>&1 &
  echo "$!" > "$pid_file"
}

start_forward pool-a "$PRIVATE/hub.kubeconfig" kind-grid-sig-demo-hub grid-sig-demo-pools service/dynamo-pool-a 59101 8000
start_forward pool-b "$PRIVATE/hub.kubeconfig" kind-grid-sig-demo-hub grid-sig-demo-pools service/dynamo-pool-b 59102 8000
start_forward site-pool "$PRIVATE/site.kubeconfig" kind-grid-sig-demo-site grid-sig-demo-site-pools service/dynamo-remote-pool 59103 8000
start_forward local-gateway "$PRIVATE/hub.kubeconfig" kind-grid-sig-demo-hub grid-system service/gw-sig-demo-local 59108 8080
start_forward local-gateway-metrics "$PRIVATE/hub.kubeconfig" kind-grid-sig-demo-hub grid-system deployment/gw-sig-demo-local 59106 9901
start_forward crosssite-gateway "$PRIVATE/site.kubeconfig" kind-grid-sig-demo-site grid-system service/gw-sig-demo-crosssite 59109 8080
start_forward crosssite-gateway-metrics "$PRIVATE/site.kubeconfig" kind-grid-sig-demo-site grid-system deployment/gw-sig-demo-crosssite 59107 9901

for port in 59101 59102 59103 59106 59107 59108 59109; do
  ready=false
  for _ in $(seq 1 60); do
    if port_busy "$port"; then ready=true; break; fi
    sleep 0.5
  done
  [[ "$ready" == true ]] || { echo "port-forward $port did not become ready" >&2; exit 1; }
done
echo 'run-owned Gateway and Frontend port-forwards are ready'
