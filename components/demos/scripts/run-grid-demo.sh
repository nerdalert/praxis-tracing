#!/usr/bin/env bash
# Run a Grid quickstart demo using Grid's Forge and xtask binaries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat >&2 <<'EOF'
Usage: run-grid-demo.sh <demo-dir> [xtask-flags...]

Environment:
  GRID_REPO   Path to a local praxis-proxy/grid checkout.
              When unset, Grid is cloned into .grid-checkout/.

Image overrides (optional):
  GRID_XTASK_GATEWAY_IMAGE
  GRID_XTASK_OPERATOR_IMAGE
  GRID_XTASK_EPP_IMAGE
  GRID_XTASK_VCR_IMAGE
  GRID_XTASK_IMAGE_PULL_POLICY
EOF
    exit 1
}

[[ $# -lt 1 ]] && usage

DEMO_DIR="$(cd "$1" && pwd)"
shift
DEMO_NAME="$(basename "${DEMO_DIR}")"

require_command() {
    local command_name="$1"
    local install_hint="${2:-}"
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "error: required command not found: ${command_name}" >&2
        if [[ -n "${install_hint}" ]]; then
            echo "       ${install_hint}" >&2
        fi
        exit 1
    fi
}

require_command cargo "Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
require_command rustc "Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
require_command kind "Install kind: https://kind.sigs.k8s.io/docs/user/quick-start/"
require_command kubectl "Install kubectl: https://kubernetes.io/docs/tasks/tools/"

if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    echo "error: required container runtime not found: docker or podman" >&2
    echo "       Install Docker or Podman before running the demo." >&2
    exit 1
fi

# Resolve or clone Grid repository.
if [[ -z "${GRID_REPO:-}" ]]; then
    require_command git "Install Git before allowing the launcher to clone Grid."
    GRID_CLONE="${SCRIPT_DIR}/../.grid-checkout"
    if [[ ! -d "${GRID_CLONE}" ]]; then
        echo "GRID_REPO not set -- cloning praxis-proxy/grid into ${GRID_CLONE}..." >&2
        git clone --depth 1 https://github.com/praxis-proxy/grid.git "${GRID_CLONE}"
    fi
    GRID_REPO="${GRID_CLONE}"
fi
GRID_REPO="$(cd "${GRID_REPO}" && pwd)"

if [[ ! -f "${GRID_REPO}/Cargo.toml" ]]; then
    echo "error: GRID_REPO (${GRID_REPO}) does not contain a Cargo.toml" >&2
    exit 1
fi

# Map demo name to xtask subcommand.
case "${DEMO_NAME}" in
    grid-glb-demo)           SUBCOMMAND="run-grid-glb-demo" ;;
    grid-llmd-pool-metrics)  SUBCOMMAND="run-grid-llmd-pool-metrics-demo" ;;
    grid-combined-site)      SUBCOMMAND="run-grid-combined-site-demo" ;;
    *)
        echo "error: unknown demo '${DEMO_NAME}'" >&2
        exit 1
        ;;
esac

FORGE_CONFIG="${DEMO_DIR}/forge.yaml"
if [[ ! -f "${FORGE_CONFIG}" ]]; then
    echo "error: forge config not found: ${FORGE_CONFIG}" >&2
    exit 1
fi

if [[ -n "${GRID_DEMO_ENTRYPOINT:-}" ]]; then
    echo "Entrypoint:   ${GRID_DEMO_ENTRYPOINT}" >&2
fi
echo "Demo:         ${DEMO_NAME}" >&2
echo "Subcommand:   ${SUBCOMMAND}" >&2
echo "Forge config: ${FORGE_CONFIG}" >&2
echo "Demo root:    ${DEMO_DIR}" >&2
echo "Grid repo:    ${GRID_REPO}" >&2
echo "" >&2

# Build tooling and run from the Grid workspace root.
cd "${GRID_REPO}"
cargo build -p forge -p xtask 2>&1
exec cargo xtask env "${SUBCOMMAND}" --forge-config "${FORGE_CONFIG}" "$@"
