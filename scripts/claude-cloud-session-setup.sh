#!/usr/bin/env bash
# Custos — per-repo SessionStart hook (requires cloned repository)
#
# Wired from .claude/settings.json. Runs after Claude Code launches on every
# session start/resume. Skips docker compose locally; runs full stack in cloud.
#
# Cloud environment tools (Foundry, solc, Playwright) are installed separately —
# copy scripts/claude-cloud-environment-setup.sh into your cloud environment UI.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
readonly PNPM_VERSION="10.33.0"
readonly NODE_VERSION="22"

log() { printf '[custos-cloud-session] %s\n' "$*"; }
warn() { printf '[custos-cloud-session] WARN: %s\n' "$*" >&2; }

run_optional() {
  log "+ $*"
  "$@" || warn "optional step failed (continuing): $*"
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

export_foundry_path() {
  export PATH="$HOME/.foundry/bin:$PATH"
  if [[ -n "${CLAUDE_ENV_FILE:-}" ]] && ! grep -q 'foundry/bin' "$CLAUDE_ENV_FILE" 2>/dev/null; then
    printf 'export PATH="$HOME/.foundry/bin:$PATH"\n' >>"$CLAUDE_ENV_FILE"
  fi
}

init_submodules() {
  if [[ ! -d "$ROOT/.git" ]]; then
    warn "Not a git checkout; skipping submodule init"
    return 0
  fi

  log "Initializing git submodules..."
  git -C "$ROOT" submodule update --init --recursive
}

install_js_deps() {
  log "Installing pnpm workspace dependencies..."
  cd "$ROOT"
  pnpm install --frozen-lockfile
}

build_contracts() {
  if [[ ! -d "$ROOT/contracts" ]]; then
    return 0
  fi

  log "Building Solidity contracts (offline)..."
  cd "$ROOT"
  export_foundry_path
  forge build --root contracts --offline
}

prepare_env_file() {
  if [[ ! -f "$ROOT/.env" && -f "$ROOT/.env.example" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    log "Created .env from .env.example"
  fi
}

start_docker_stack() {
  if [[ ! -f "$ROOT/docker-compose.yml" ]]; then
    return 0
  fi

  log "Starting docker compose stack..."
  cd "$ROOT"
  export_foundry_path
  run_optional docker compose up -d --build
}

main() {
  cd "$ROOT"
  activate_node_toolchain
  init_submodules
  install_js_deps
  build_contracts
  prepare_env_file

  if [[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]]; then
    start_docker_stack
  fi

  log "Session setup complete."
}

main "$@"
