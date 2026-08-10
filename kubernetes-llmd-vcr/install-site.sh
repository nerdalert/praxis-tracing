#!/usr/bin/env bash
set -euo pipefail

site="${1:-}"
case "$site" in east1|east2|west1|west2) ;; *) echo "usage: $0 east1|east2|west1|west2" >&2; exit 2 ;; esac

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KUBECONFIG="${KUBECONFIG:-/tmp/kubernetes-access/clusters/${site}/auth/kubeconfig}"
namespace="${LLMD_NAMESPACE:-llm-d}"
grid_namespace="${GRID_NAMESPACE:-grid-system}"
epp_release="llmd-${site}"
vcr_release="kubernetes-llmd-vcr-${site}"
pool_name="pool-${site}"
provider_name="llmd-${site}-provider"

command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }
command -v helm >/dev/null || { echo "helm is required" >&2; exit 1; }
kubectl cluster-info >/dev/null
kubectl get ns "$grid_namespace" >/dev/null

# The existing Grid installation provides Gateway API CRDs but not the
# Gateway API Inference Extension CRDs required by the llm-d Router chart.
kubectl apply -k \
  'https://github.com/kubernetes-sigs/gateway-api-inference-extension/config/crd?ref=v1.5.0' \
  >/dev/null

kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

helm upgrade --install "$epp_release" \
  oci://registry.k8s.io/gateway-api-inference-extension/charts/standalone \
  --version v1.5.0 \
  --namespace "$namespace" \
  --set inferenceExtension.endpointsServer.createInferencePool=true \
  --set-string "inferencePool.modelServers.matchLabels.app=vllm-vcr" \
  --set-string "inferencePool.modelServers.matchLabels.pool=${pool_name}" \
  --set inferencePool.targetPorts[0].number=8000 \
  --set inferencePool.modelServerType=vllm \
  --set inferenceExtension.monitoring.prometheus.auth.enabled=false \
  --wait --timeout 10m

helm upgrade --install "$vcr_release" "$root_dir/chart" \
  --namespace "$namespace" \
  --set "poolName=${pool_name}" \
  --wait --timeout 10m

kubectl -n "$namespace" wait --for=condition=available \
  deployment/kubernetes-llmd-vcr --timeout=10m

kubectl patch gridnetwork kubernetes-grid --type=merge \
  -p '{"spec":{"routingPolicy":"scoreFirst","scoringPolicy":{"strategy":"queueDepth"}}}'

kubectl apply -f - <<YAML
apiVersion: grid.praxis-proxy.io/v1alpha1
kind: InferenceProvider
metadata:
  name: ${provider_name}
spec:
  gridNetworkRef: kubernetes-grid
  providerKind: vllm-vcr
  backendKind: local
  endpoint: http://${epp_release}-epp.${namespace}.svc.cluster.local:8081
  siteSelector:
    matchLabels:
      grid.praxis-proxy.io/provider-site: ${site}
  accessPolicy:
    siteSelector:
      matchLabels: {}
  models:
    - name: Qwen/Qwen3-0.6B
      capabilities: [text_generation]
      contextWindow: 4096
  healthCheck:
    path: /health
    interval: 30s
    timeout: 5s
  metricsConfig:
    path: /metrics
    timeout: 2s
    staleMetricsSeconds: 20
    metricsEndpoint: http://${epp_release}-epp.${namespace}.svc.cluster.local:9090
    poolName: ${epp_release}
    queueCapacity: 4
    signalNames:
      kvCacheUtilization: inference_pool_average_kv_cache_utilization
      queueDepth: inference_pool_average_queue_size
      healthy: inference_pool_ready_pods
YAML

kubectl -n "$namespace" rollout status deployment/"${epp_release}-epp" --timeout=10m
kubectl -n "$namespace" get pods,svc -l "app.kubernetes.io/name=${epp_release}-epp" -o wide
kubectl -n "$grid_namespace" get inferenceprovider "$provider_name" -o wide

# The Grid overlay and the static Praxis gateway cluster maps are separate
# inputs. Configure both after the provider is available so the live request
# path is consumer gateway -> provider gateway -> EPP -> VCR.
for attempt in $(seq 1 60); do
  if kubectl -n "$grid_namespace" get configmap \
      grid-overlay-kubernetes-grid-consumer-gateway \
      -o jsonpath='{.data.routing-overlay\.json}' 2>/dev/null | \
      jq -e --arg provider "$provider_name" \
        '.overlay.candidates[] | select(.cluster == $provider)' >/dev/null; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "timed out waiting for the Grid overlay candidate $provider_name" >&2
    exit 1
  fi
  sleep 2
done
"$root_dir/configure-grid-route.sh" "$site"
