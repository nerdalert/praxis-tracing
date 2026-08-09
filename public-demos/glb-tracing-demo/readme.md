# Grid GLB Demo

One stable HTTPS inference endpoint backed by two active Praxis edge gateways,
two private provider gateways, and a local GTM emulator that selects a healthy
edge. The east provider cluster hosts two independent providers for
`Qwen/Qwen3-0.6B`, proving that Grid does not assume one provider per cluster.

## Topology

```text
                    Inference client
                          |
                          v
               +--------------------+
               | GTM emulator       |
               | (grid-glb-gtm-     |
               |  emulator)         |
               +---------+----------+
                         |
                +--------+--------+
                |                 |
                v                 v
      +----------------+  +----------------+
      | east-edge      |  | west-edge      |
      | intelligent_   |  | intelligent_   |
      | route + overlay|  | route + overlay|
      +-------+--------+  +-------+--------+
              |                    |
       +------+------+     +------+------+
       |             |     |             |
       v             v     v             v
+-----------+  +-----------+  +-----------+
| east-     |  | east-     |  | west-     |
| provider  |  | provider  |  | provider  |
| (primary) |  | (second.) |  |           |
+-----------+  +-----------+  +-----------+

5 Kind clusters, 4-member SWIM mesh (GTM excluded)
```

## What It Proves

- Active/active global routing with independent Grid provider selection
- Local GTM emulator selects a healthy edge (not Route 53 or Internet-scale GSLB)
- Two independent providers at the east site with distinct stable IDs
- Secure provider boundary: mTLS, peer authorization, credential replacement
- Edge and provider session affinity under separate keys
- Metrics-driven provider drain (queue depth triggers `existing_only`)
- Live overlay hot reload without pod restart
- Edge withdrawal, recovery, and failback behind one HTTPS name

## Prerequisites

- A local [praxis-proxy/grid](https://github.com/praxis-proxy/grid) checkout (or set `GRID_REPO`)
- Docker
- kind, kubectl, curl, OpenSSL on `PATH`
- Rust stable 1.96+ and the repository-pinned nightly toolchain
- Capacity for five single-node Kind clusters

## Registry Images

```bash
export GRID_XTASK_GATEWAY_IMAGE=ghcr.io/nerdalert/praxis-ai:otel-glb-demo
export GRID_XTASK_OPERATOR_IMAGE=ghcr.io/praxis-proxy/grid-operator:v0.1.3
export GRID_XTASK_VCR_IMAGE=ghcr.io/neuralmagic/vllm-vcr:vllm0.23
export GRID_XTASK_IMAGE_PULL_POLICY=Always
```

The gateway image is the OTel-enabled Praxis AI image. The released
`grid-ai-rollup:v0.1.3` image is not a substitute because it does not contain
the tracing instrumentation. Provider clusters run
[vllm-vcr](https://github.com/neuralmagic/vllm-vcr/blob/main/README.md).

## Quick Start

```bash
./run.sh --full
```

The command above leaves all five Kind clusters running for observation. It
does not start Jaeger or the UI; use the tracing runbook for the complete
observable workflow. `run.sh` uses the VCR-backed topology in
`grid/tests/e2e/topologies/grid-glb-demo/forge.yaml` by default; set
`GLB_FORGE_CONFIG` only when intentionally testing another Forge config.

## Full Mode

```bash
./run.sh --full
```

Full mode adds repeated affinity, provider drain, edge withdrawal/recovery,
sequential Grid operator restarts, and a configured request soak.

## Teardown and Keep-on-Failure

Only run teardown after observation is complete:

```bash
cd ..
./scripts/teardown-tracing.sh
./scripts/run-tracing.sh --teardown
```

## Evidence

Each run writes machine-readable evidence to a timestamped directory under
`.forge/evidence/` (or the path given by `--evidence-dir`).

See [e2e-demo-output.txt](e2e-demo-output.txt) for checked-in example output
from a quick cold run.

## Known Limitations

- The GTM emulator is a local stand-in; it does not reproduce Internet routing,
  DNS propagation, Anycast, geographic steering, or DDoS protection.
- Kind networking does not represent production latency or failure modes.
- VCR provides simulated inference responses; this demo does not measure
  production model quality or throughput.
- The emulator-to-edge hop is plaintext HTTP inside the isolated demo network.

## Implementation Documentation

See the [Grid repository](https://github.com/praxis-proxy/grid) for full
architecture, design documentation, and implementation details.
