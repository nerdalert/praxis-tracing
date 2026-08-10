#!/usr/bin/env bash
set -euo pipefail

site="${1:-}"
case "$site" in east1|east2|west1|west2) ;; *) echo "usage: $0 east1|east2|west1|west2" >&2; exit 2 ;; esac

export KUBECONFIG="${KUBECONFIG:-/tmp/kubernetes-access/clusters/${site}/auth/kubeconfig}"
namespace="${LLMD_NAMESPACE:-llm-d}"
provider_name="llmd-${site}-provider"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$root_dir/configure-grid-route.sh" "$site" --remove
kubectl delete inferenceprovider "$provider_name" --ignore-not-found
helm uninstall "kubernetes-llmd-vcr-${site}" --namespace "$namespace" --ignore-not-found
helm uninstall "llmd-${site}" --namespace "$namespace" --ignore-not-found
