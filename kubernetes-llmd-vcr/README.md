# Kubernetes llm-d/EPP + vllm-vcr deployment

This is the production-shaped Kubernetes deployment path for the tracing
environment. It installs one llm-d Router/EPP release and one Helm-managed
vllm-vcr pool per Kubernetes cluster. Grid routes requests to the Router service;
the Router/EPP selects a VCR backend and exposes pool metrics for Grid to
scrape.

The four local targets are `east1`, `east2`, `west1`, and `west2`. Their
kubeconfigs default to `/tmp/kubernetes-access/clusters/<site>/auth/kubeconfig` for
the current workstation, but the scripts accept an alternate
`KUBECONFIG_TEMPLATE` containing one `%s` site placeholder. No cloud-provider,
organization, or DNS-specific behavior is required.
The script never deletes the existing Grid releases or mock providers.

## Versions

The initial deployment intentionally uses the already-installed Grid v1.3
resources:

```text
Grid operator and gateway:  ghcr.io/praxis-proxy/*:v0.1.3
llm-d EPP image:           registry.k8s.io/gateway-api-inference-extension/epp:v1.5.0
llm-d Router chart:        GAIE standalone chart v1.5.0
vllm-vcr:                  ghcr.io/neuralmagic/vllm-vcr:vllm0.23
model:                    Qwen/Qwen3-0.6B
```

Grid v1.3 supports `metricsConfig` and `scoringPolicy`, but not
`metricsRefreshInterval`. Do not add that field to the initial v1.3
deployment. With v1.3, the operator's periodic fallback remains the released
interval; Kubernetes resource changes are still event-driven. The newer
refresh-interval CR change is a later operator upgrade.

## Prerequisites

- `kubectl`, `helm`, and `jq`
- cluster-admin access to all four Kubernetes kubeconfigs
- access to the public VCR and llm-d registries
- the four clusters already running Grid v1.3 and the `grid-system` namespace

Confirm the current state before installation:

```bash
for site in east1 east2 west1 west2; do
  KUBECONFIG=/tmp/kubernetes-access/clusters/$site/auth/kubeconfig \
    kubectl get nodes,gridnetwork,gridsite,inferenceprovider -A
done
```

## Install one site

Run from this directory. The site name controls the EPP release, VCR pool
label, and Grid provider identity.

```bash
./install-site.sh east1
```

The command performs these steps:

1. installs the official GAIE standalone Router/EPP Helm chart in `llm-d`;
2. installs the local `kubernetes-llmd-vcr` Helm chart with two VCR replicas;
3. waits for EPP and VCR readiness;
4. applies the site-local `InferenceProvider` with EPP metrics mapping;
5. enables `scoreFirst` and `queueDepth` on the existing `kubernetes-grid` network;
6. waits for the Grid overlay to include the VCR provider;
7. adds the VCR provider to the consumer and provider gateway route maps;
8. restarts those gateways and sends one request through the full Grid path.

The official chart's Prometheus metrics endpoint is authenticated by default.
This deployment explicitly sets
`inferenceExtension.monitoring.prometheus.auth.enabled=false` because the
metrics Service is ClusterIP-only and is consumed inside the cluster by the
Grid operator. Do not expose that Service publicly. If the metrics endpoint
must cross a trust boundary, use the chart's authenticated mode and configure
Grid `metricsConfig.tls` and credentials instead.

## Install all four sites

```bash
for site in east1 east2 west1 west2; do
  ./install-site.sh "$site"
done
```

The installs are intentionally sequential so a failed site is easy to
identify and so registry or cluster pressure does not hide the first error.

## What Grid scrapes and scores

For a site such as `east1`, the request and metrics paths are:

```text
Grid InferenceProvider endpoint
  http://llmd-east1-epp.llm-d.svc.cluster.local:8081
        ↓ request proxy and EPP endpoint picker
  vcr-service.llm-d.svc.cluster.local:8000

Grid metricsConfig.metricsEndpoint
  http://llmd-east1-epp.llm-d.svc.cluster.local:9090/metrics
        ↓ pool metrics
  queueDepth and KV-cache signals
        ↓
  Grid queueDepth score and routing overlay
```

Grid scores the logical site pool. EPP continues to select an individual VCR
pod within that pool. Grid never ranks the individual VCR pods.

The VCR selector label and the EPP metric pool label are different values.
The VCR pods use `pool-east1` for endpoint discovery, while the official
Router chart names the InferencePool `llmd-east1`; Grid must use the latter in
`metricsConfig.poolName` because it matches the EPP metric's `name` label.

The applied metric names are:

```yaml
signalNames:
  queueDepth: inference_pool_average_queue_size
  kvCacheUtilization: inference_pool_average_kv_cache_utilization
  healthy: inference_pool_ready_pods
queueCapacity: 4
```

## Gateway request path

The `InferenceProvider` and overlay are not, by themselves, a complete
request route. Praxis gateway configuration also has to contain the cluster
names that the overlay can select. `configure-grid-route.sh` performs that
site-local wiring without replacing the existing mock routes:

```text
consumer-gateway:8080
  -> provider-gateway.grid-system.svc.cluster.local:8443 (mTLS)
  -> llmd-<site>-epp.llm-d.svc.cluster.local:8081
  -> vllm-vcr pods selected by the EPP InferencePool
```

The script adds the `llmd-<site>-provider` hop to the consumer gateway and
adds the Qwen route plus `llmd-epp` backend to the provider gateway. It is
idempotent and leaves the existing mock-provider entries in place. To inspect
the rendered changes without touching the cluster:

```bash
./configure-grid-route.sh east1 --dry-run
```

The supported end-to-end request is OpenAI chat completions. Use the model
name exactly as shown; `/v1/completions` is not included in the current
provider route configuration:

```bash
kubectl -n grid-system port-forward svc/consumer-gateway 18080:8080

curl -fsS http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"hello"}],"max_tokens":8}'
```

Successful evidence is HTTP 200, a response containing `choices`, two
`Via: 1.1 praxis` hops, and the site-specific provider-gateway attribution.
Direct EPP success alone proves only the Router-to-VCR segment; the chat
request above proves the consumer-to-provider-to-EPP path.

## Validation commands

```bash
site=east1
export KUBECONFIG=/tmp/kubernetes-access/clusters/$site/auth/kubeconfig

kubectl -n llm-d get pods,svc
kubectl -n llm-d get svc llmd-$site-epp -o wide
kubectl -n llm-d port-forward svc/llmd-$site-epp 19090:9090 18081:8081

# In another terminal:
curl -fsS http://127.0.0.1:19090/metrics | \
  grep -E 'inference_pool_(average_queue_size|average_kv_cache_utilization|ready_pods)'

curl -fsS http://127.0.0.1:18081/v1/models
curl -fsS http://127.0.0.1:18081/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"hello"}],"max_tokens":8}'

kubectl -n grid-system get inferenceprovider -o wide
kubectl get gridnetwork kubernetes-grid -o yaml
kubectl -n grid-system get configmap grid-overlay-kubernetes-grid-consumer-gateway -o yaml
```

Expected evidence is a ready VCR deployment, an EPP metrics response with
pool signals, an available `InferenceProvider`, and a Grid overlay candidate
whose endpoint is the EPP Router service rather than the VCR service.

## Completed Kubernetes validation

The initial four-site deployment was validated on `east1`, `east2`, `west1`,
and `west2`:

- all four EPP Router Helm releases reached `2/2` ready containers;
- all four VCR Helm releases reached two ready replicas;
- all four EPP metrics endpoints returned queue, KV-cache, running-request,
  per-pod queue, and ready-pod metrics;
- all four Grid providers reported `Available`;
- all four overlays contained `Qwen/Qwen3-0.6B` with `fresh=true`, score `1.0`,
  and rank `0` at zero load;
- `/v1/models` and `/v1/chat/completions` succeeded through every EPP
  Router.
- Full consumer-gateway requests succeeded on all four sites with HTTP 200,
  two Praxis hops, and site-specific provider-gateway attribution.

The current clusters still retain their original Grid v1.3 mock providers.
The VCR/EPP releases are additive and are named by site, so the original
Grid releases can be rolled back independently.

## Deploy the OTel tracer

The released v1.3 gateway image does not contain the experimental Praxis OTel
hooks. `deploy-tracing.sh` switches only the consumer and provider gateway
containers to the immutable OTel rollup image and deploys an internal Jaeger
plus OTel Collector in each cluster. The published image's routing hooks emit
the routing and provider spans; runtime validation showed that this image does
not register the newer standalone `otel_context` filter, so the deployment
does not add that filter and avoids a gateway crash-loop. A future image that
registers `otel_context` can enable full request-lifecycle spans explicitly.
The
collector and Jaeger Services are ClusterIP-only; no OTLP port is exposed
outside a cluster.

The default image is:

```text
ghcr.io/nerdalert/praxis-ai@sha256:029449dea839f388c1b3282c0168732c8e1a54a915bc58c83dee3fa4d2472d5c
```

Deploy all four sites:

```bash
./deploy-tracing.sh all
```

Or deploy one site with an alternate kubeconfig layout:

```bash
KUBECONFIG_TEMPLATE="$PWD/kubeconfigs/%s.yaml" ./deploy-tracing.sh east1
```

The resulting trace path is:

```text
consumer gateway SERVER span
  -> routing.select and CLIENT span
  -> provider gateway SERVER span and provider.validate
  -> EPP Router -> vllm-vcr
```

Inspect one cluster's Jaeger UI through a local port-forward:

```bash
KUBECONFIG=/tmp/kubernetes-access/clusters/east1/auth/kubeconfig \
  kubectl -n praxis-tracing port-forward svc/jaeger 16686:16686
```

Then open `http://127.0.0.1:16686`. Generate a request through the consumer
gateway using the chat-completions command above and search Jaeger for the
site-specific `praxis-<site>-consumer-gateway` service. This deployment uses
one Jaeger per cluster; a shared multi-cluster Jaeger requires an authenticated
cross-cluster collector design and is intentionally not assumed here.

### Validation note

The gateway-to-Collector leg has been verified with the OTel Collector's
development exporter during bring-up: routed requests produced the expected
two- and three-span batches. The pinned `jaegertracing/all-in-one:1` image
accepted OTLP and Zipkin ingestion requests but did not expose those spans
through its query API in this environment. Treat Jaeger query visibility as a
deployment gate; if it fails, inspect Collector export errors and Jaeger
collector metrics before presenting the UI. The deployment script does not
leave the development exporter enabled.

## Remove only this deployment

This does not remove the existing Grid installation:

```bash
./uninstall-site.sh east1
```

The script first removes only the route entries added for this site, then
removes the matching `llmd-east1-provider` resource and the two Helm
releases. Existing mock routes, Grid releases, and the `kubernetes-grid` scoring
policy are preserved. Use `--remove --dry-run` on the route helper to inspect
the route cleanup before applying it:

```bash
./configure-grid-route.sh east1 --remove --dry-run
```
