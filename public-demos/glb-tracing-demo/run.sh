#!/usr/bin/env bash
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${DEMO_DIR}/.." && pwd)"
GRID_REPO="${GRID_REPO:-${ROOT_DIR}/grid}"
FORGE_CONFIG="${GLB_FORGE_CONFIG:-${GRID_REPO}/tests/e2e/topologies/grid-glb-demo/forge.yaml}"

if [[ ! -f "${GRID_REPO}/Cargo.toml" ]]; then
    echo "error: GRID_REPO (${GRID_REPO}) does not contain Cargo.toml" >&2
    exit 1
fi
if [[ ! -f "${FORGE_CONFIG}" ]]; then
    echo "error: GLB_FORGE_CONFIG (${FORGE_CONFIG}) does not exist" >&2
    exit 1
fi

cd "${GRID_REPO}"
exec cargo xtask env run-grid-glb-demo \
    --forge-config "${FORGE_CONFIG}" \
    "$@"
