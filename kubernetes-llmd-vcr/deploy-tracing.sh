#!/usr/bin/env bash
set -euo pipefail

site_arg="${1:-all}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${PRAXIS_OTEL_IMAGE:-ghcr.io/nerdalert/praxis-ai@sha256:029449dea839f388c1b3282c0168732c8e1a54a915bc58c83dee3fa4d2472d5c}"
namespace="${GRID_NAMESPACE:-grid-system}"
trace_namespace="${TRACE_NAMESPACE:-praxis-tracing}"
collector_endpoint="http://praxis-otel-collector.${trace_namespace}.svc.cluster.local:4318"
kubeconfig_template="${KUBECONFIG_TEMPLATE:-/tmp/kubernetes-access/clusters/%s/auth/kubeconfig}"

if [[ "$site_arg" == all ]]; then
  sites=(east1 east2 west1 west2)
else
  sites=("$site_arg")
fi
for site in "${sites[@]}"; do
  case "$site" in east1|east2|west1|west2) ;; *)
    echo "usage: $0 [all|east1|east2|west1|west2]" >&2
    exit 2
    ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v yq >/dev/null || { echo "yq is required" >&2; exit 1; }

for site in "${sites[@]}"; do
  if [[ -n "${KUBECONFIG_OVERRIDE:-}" ]]; then
    export KUBECONFIG="$KUBECONFIG_OVERRIDE"
  else
    printf -v KUBECONFIG "$kubeconfig_template" "$site"
    export KUBECONFIG
  fi
  echo "=== tracing: $site ==="
  kubectl apply -f "$root_dir/tracing/manifests.yaml" >/dev/null
  kubectl -n "$trace_namespace" rollout restart deployment/praxis-otel-collector
  kubectl -n "$trace_namespace" rollout status deployment/jaeger --timeout=5m
  kubectl -n "$trace_namespace" rollout status deployment/praxis-otel-collector --timeout=5m

  work_dir="$(mktemp -d)"
  for config in consumer-praxis-config provider-praxis-config; do
    kubectl -n "$namespace" get configmap "$config" \
      -o jsonpath='{.data.praxis\.yaml}' >"$work_dir/$config.yaml"
  done

  yq -i '(.filter_chains[] | select(.name == "main") | .filters) |=
    [.[] | select(.filter != "otel_context")]' \
    "$work_dir/consumer-praxis-config.yaml"
  yq -i '(.filter_chains[] | select(.name == "provider-inference") | .filters) |=
    [.[] | select(.filter != "otel_context")]' \
    "$work_dir/provider-praxis-config.yaml"
  for config in consumer-praxis-config provider-praxis-config; do
    kubectl -n "$namespace" create configmap "$config" \
      --from-file=praxis.yaml="$work_dir/$config.yaml" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  done

  kubectl -n "$namespace" set image deployment/consumer-gateway \
    praxis="$image"
  kubectl -n "$namespace" set image deployment/provider-gateway \
    praxis="$image"
  kubectl -n "$namespace" set env deployment/consumer-gateway \
    "OTEL_EXPORTER_OTLP_ENDPOINT=$collector_endpoint" \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_PROPAGATORS=tracecontext,baggage \
    OTEL_SERVICE_NAME="praxis-${site}-consumer-gateway" \
    OTEL_RESOURCE_ATTRIBUTES="deployment.environment=grid-${site},service.namespace=grid-system"
  kubectl -n "$namespace" set env deployment/provider-gateway \
    "OTEL_EXPORTER_OTLP_ENDPOINT=$collector_endpoint" \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_PROPAGATORS=tracecontext,baggage \
    OTEL_SERVICE_NAME="praxis-${site}-provider-gateway" \
    OTEL_RESOURCE_ATTRIBUTES="deployment.environment=grid-${site},service.namespace=grid-system"
  kubectl -n "$namespace" rollout status deployment/consumer-gateway --timeout=5m
  kubectl -n "$namespace" rollout status deployment/provider-gateway --timeout=5m
  rm -rf "$work_dir"
  echo "OTel image and internal collector configured for $site"
done

echo
echo "Tracing is deployed. Jaeger is internal to each cluster."
echo "Inspect east1 with:"
echo "  KUBECONFIG=/tmp/kubernetes-access/clusters/east1/auth/kubeconfig kubectl -n $trace_namespace port-forward svc/jaeger 16686:16686"
