#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# COPY THIS ENTIRE FILE into claude.ai/code → Environment settings → Setup script
#
# Cloud environments are NOT repo-based — they are shared across projects and
# this script runs before any repository is cloned. Do NOT reference project
# paths here. Project setup is in scripts/claude-cloud-session-setup.sh
# (SessionStart hook committed to each repo).
#
# Pre-installed on the cloud VM (no action needed):
#   Node 20/21/22 (nvm), pnpm/npm/yarn, Docker + docker compose, git/jq/ripgrep
#   https://code.claude.com/docs/en/claude-code-on-the-web#installed-tools
#
# Docker daemon is NOT running during this setup script — do not pull images here.
# Image pulls and `docker compose up` run in the repo SessionStart hook instead.
#
# Trusted network mode blocks binaries.soliditylang.org — solc is fetched from
# GitHub releases instead. Add rpc.mantle.xyz + api.1delta.io to Allowed domains
# in the environment for Mantle fork tests / live RPC (per-repo concern).
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

readonly FOUNDRY_VERSION="v1.4.1"
readonly SOLC_VERSION="0.8.28"
readonly NODE_VERSION="22"
readonly PNPM_VERSION="10.33.0"
readonly FOUNDRY_BIN_DIR="$HOME/.foundry/bin"

log() { printf '[custos-cloud-env] %s\n' "$*"; }
warn() { printf '[custos-cloud-env] WARN: %s\n' "$*" >&2; }
die() { printf '[custos-cloud-env] ERROR: %s\n' "$*" >&2; exit 1; }

run_optional() {
  log "+ $*"
  "$@" || warn "optional step failed (continuing): $*"
}

persist_foundry_path() {
  export PATH="${FOUNDRY_BIN_DIR}:$PATH"
  if ! grep -q 'foundry/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.foundry/bin:$PATH"' >>"$HOME/.bashrc"
  fi
}

activate_node_toolchain() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use "$NODE_VERSION" >/dev/null 2>&1 || nvm install "$NODE_VERSION"
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || true
  fi
}

install_foundry() {
  persist_foundry_path
  mkdir -p "$FOUNDRY_BIN_DIR"

  if [[ -x "${FOUNDRY_BIN_DIR}/forge" ]]; then
    log "Foundry already installed: $("${FOUNDRY_BIN_DIR}/forge" --version | head -1)"
    return 0
  fi

  local arch="amd64"
  case "$(uname -m)" in
    aarch64 | arm64) arch="arm64" ;;
    x86_64) arch="amd64" ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  local tarball="foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  local url="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/${tarball}"

  log "Installing Foundry ${FOUNDRY_VERSION} from GitHub releases..."
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$url" | tar -xzf - -C "$tmp"

  for bin in forge cast anvil chisel; do
    [[ -f "$tmp/$bin" ]] || die "Foundry archive missing $bin"
    install -m 755 "$tmp/$bin" "${FOUNDRY_BIN_DIR}/${bin}"
  done
  rm -rf "$tmp"

  [[ -x "${FOUNDRY_BIN_DIR}/forge" ]] || die "Foundry install failed: forge not found in ${FOUNDRY_BIN_DIR}"
  log "Foundry installed: $("${FOUNDRY_BIN_DIR}/forge" --version | head -1)"
}

install_solc_offline() {
  local solc_dir="$HOME/.svm/${SOLC_VERSION}"
  local solc_bin="${solc_dir}/solc-${SOLC_VERSION}"

  if [[ -x "$solc_bin" ]]; then
    log "solc ${SOLC_VERSION} already present"
    return 0
  fi

  local asset="solc-static-linux"
  case "$(uname -m)" in
    aarch64 | arm64) asset="solc-static-linux-arm" ;;
    x86_64) asset="solc-static-linux" ;;
    *) warn "Unknown CPU arch; trying ${asset}" ;;
  esac

  log "Installing solc ${SOLC_VERSION} from GitHub releases..."
  mkdir -p "$solc_dir"
  curl -fsSL -o "$solc_bin" \
    "https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/${asset}"
  chmod +x "$solc_bin"
}

install_playwright() {
  log "Caching Playwright Chromium + system deps..."
  run_optional npx --yes playwright install-deps chromium
  run_optional npx --yes playwright install chromium
}

verify_toolchain() {
  log "Verifying environment toolchain..."
  node --version
  pnpm --version
  persist_foundry_path
  "${FOUNDRY_BIN_DIR}/forge" --version | head -1
  run_optional npx --yes playwright --version
  log "Cloud environment setup complete."
}

activate_node_toolchain
install_foundry
install_solc_offline
install_playwright
verify_toolchain
