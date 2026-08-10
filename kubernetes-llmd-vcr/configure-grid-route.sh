#!/usr/bin/env bash
set -euo pipefail

site="${1:-}"
case "$site" in east1|east2|west1|west2) ;; *)
  echo "usage: $0 east1|east2|west1|west2 [--dry-run|--remove]" >&2
  exit 2
  ;;
esac

dry_run=false
remove=false
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --remove) remove=true ;;
    *)
      echo "usage: $0 east1|east2|west1|west2 [--dry-run|--remove]" >&2
      exit 2
      ;;
  esac
done

export KUBECONFIG="${KUBECONFIG:-/tmp/kubernetes-access/clusters/${site}/auth/kubeconfig}"
grid_namespace="${GRID_NAMESPACE:-grid-system}"
epp_namespace="${LLMD_NAMESPACE:-llm-d}"
consumer_config="consumer-praxis-config"
provider_config="provider-praxis-config"
provider_name="llmd-${site}-provider"
epp_service="llmd-${site}-epp"
provider_sni="${site}-provider.grid.internal"

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v yq >/dev/null || { echo "yq is required" >&2; exit 1; }
kubectl cluster-info >/dev/null

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

kubectl -n "$grid_namespace" get configmap "$consumer_config" \
  -o jsonpath='{.data.praxis\.yaml}' >"$work_dir/consumer.yaml"
kubectl -n "$grid_namespace" get configmap "$provider_config" \
  -o jsonpath='{.data.praxis\.yaml}' >"$work_dir/provider.yaml"

stable_id="$(kubectl -n "$grid_namespace" get configmap \
  grid-overlay-kubernetes-grid-consumer-gateway \
  -o jsonpath='{.data.routing-overlay\.json}' | \
  jq -er --arg provider "$provider_name" \
    '.overlay.candidates[] | select(.cluster == $provider) | .stable_id' | head -n1)"

if [[ -z "$stable_id" ]]; then
  echo "no overlay candidate found for $provider_name" >&2
  exit 1
fi

if $remove; then
  yq_cluster="$provider_name" yq_candidate="$stable_id" \
    yq -i '(.filter_chains[] | select(.name == "main") | .filters[] |
      select(.filter == "intelligent_route") | .provider_hop_clusters) |=
      ([.[] | select(. != strenv(yq_cluster))])' "$work_dir/consumer.yaml"
  yq_cluster="$provider_name" \
    yq -i '(.filter_chains[] | select(.name == "main") | .filters[] |
      select(.filter == "load_balancer") | .clusters) |=
      ([.[] | select(.name != strenv(yq_cluster))])' "$work_dir/consumer.yaml"
  yq_candidate="$stable_id" \
    yq -i '(.filter_chains[] | select(.name == "provider-inference") | .filters[] |
      select(.filter == "provider_route") | .routes) |=
      ([.[] | select(.candidate_id != strenv(yq_candidate))])' "$work_dir/provider.yaml"
  yq -i '(.filter_chains[] | select(.name == "provider-inference") | .filters[] |
    select(.filter == "load_balancer") | .clusters) |=
    ([.[] | select(.name != "llmd-epp")])' "$work_dir/provider.yaml"

  if $dry_run; then
    echo "--- rendered consumer config after removal ---"
    cat "$work_dir/consumer.yaml"
    echo "--- rendered provider config after removal ---"
    cat "$work_dir/provider.yaml"
    exit 0
  fi

  kubectl -n "$grid_namespace" create configmap "$consumer_config" \
    --from-file=praxis.yaml="$work_dir/consumer.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$grid_namespace" create configmap "$provider_config" \
    --from-file=praxis.yaml="$work_dir/provider.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$grid_namespace" rollout restart deployment/consumer-gateway deployment/provider-gateway
  kubectl -n "$grid_namespace" rollout status deployment/consumer-gateway --timeout=5m
  kubectl -n "$grid_namespace" rollout status deployment/provider-gateway --timeout=5m
  echo "Grid gateway route removed for $provider_name."
  exit 0
fi

# Add the VCR-backed provider gateway to the consumer's route map and the
# EPP Router to the provider gateway's backend map. Existing mock routes are
# preserved. The guards make this command idempotent.
yq_cluster="$provider_name" yq_sni="$provider_sni" \
  yq -i '(.filter_chains[] | select(.name == "main") | .filters[] |
    select(.filter == "intelligent_route") | .provider_hop_clusters) |=
    (((. // []) + [strenv(yq_cluster)]) | unique)' "$work_dir/consumer.yaml"
yq_cluster="$provider_name" yq_sni="$provider_sni" \
  yq -i '(.filter_chains[] | select(.name == "main") | .filters[] |
    select(.filter == "load_balancer") | .clusters) |=
    (((. // []) + [{"name": strenv(yq_cluster),
      "tls": {"ca": {"ca_path": "/etc/praxis/tls/ca.crt"},
        "client_cert": {"cert_path": "/etc/praxis/tls/tls.crt",
          "key_path": "/etc/praxis/tls/tls.key"},
        "sni": strenv(yq_sni), "verify": true},
      "endpoints": ["provider-gateway.grid-system.svc.cluster.local:8443"]}]) |
      unique_by(.name))' "$work_dir/consumer.yaml"

yq_candidate="$stable_id" yq_epp="$epp_service" \
  yq_provider="$provider_name" yq_ns="$epp_namespace" \
  yq -i '(.filter_chains[] | select(.name == "provider-inference") | .filters[] |
    select(.filter == "provider_route") | .routes) |=
    (((. // []) + [{"candidate_id": strenv(yq_candidate),
      "model": "Qwen/Qwen3-0.6B",
      "paths": ["/v1/chat/completions", "/v1/responses"],
      "cluster": "llmd-epp"}]) | unique_by(.candidate_id))' "$work_dir/provider.yaml"
yq_epp="$epp_service" yq_ns="$epp_namespace" \
  yq -i '(.filter_chains[] | select(.name == "provider-inference") | .filters[] |
    select(.filter == "load_balancer") | .clusters) |=
    (((. // []) + [{"name": "llmd-epp", "endpoints":
      [(strenv(yq_epp) + "." + strenv(yq_ns) + ".svc.cluster.local:8081")]}]) |
      unique_by(.name))' "$work_dir/provider.yaml"

echo "site: $site"
echo "VCR provider: $provider_name"
echo "overlay stable_id: $stable_id"
echo "consumer route: consumer gateway -> $provider_name"
echo "provider route: provider gateway -> $epp_service.$epp_namespace.svc.cluster.local:8081"

if $dry_run; then
  echo
  echo "--- rendered consumer config ---"
  cat "$work_dir/consumer.yaml"
  echo
  echo "--- rendered provider config ---"
  cat "$work_dir/provider.yaml"
  exit 0
fi

kubectl -n "$grid_namespace" create configmap "$consumer_config" \
  --from-file=praxis.yaml="$work_dir/consumer.yaml" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$grid_namespace" create configmap "$provider_config" \
  --from-file=praxis.yaml="$work_dir/provider.yaml" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl -n "$grid_namespace" rollout restart deployment/consumer-gateway deployment/provider-gateway
kubectl -n "$grid_namespace" rollout status deployment/consumer-gateway --timeout=5m
kubectl -n "$grid_namespace" rollout status deployment/provider-gateway --timeout=5m

echo "Grid gateway route configured and both gateways restarted."
