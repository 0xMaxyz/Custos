# Sentinel

**AI risk-guardian real-yield account on Mantle.** Deposit USDC; an AI agent earns
tokenized-Treasury (USDY) yield with an Aave v3 USDC liquidity floor, and
**autonomously de-risks on-chain** into AUSD/USDC when RWA danger appears (depeg,
oracle staleness, issuer/regulatory shock) — recording every decision **and its
evidence** on-chain under an ERC-8004 identity.

The verifiable autonomous defense — not the swap-to-USDY — is the product. See
[`PLAN.md`](./PLAN.md), [`ROADMAP.md`](./ROADMAP.md), [`SPEC.md`](./SPEC.md),
[`AGENTS.md`](./AGENTS.md), and [`UI.md`](./UI.md).

## Monorepo layout

```
contracts/         Foundry (Solidity) — vault, adapters, guardrails, benchmark
agent/             Node + TS + Fastify — risk engine, LLM layer, executor
web/               React + Vite + Tailwind + daisyUI — dashboard & risk feed
packages/shared/   Shared types, verified addresses, token metadata
```

## Prerequisites

- Node ≥ 22 and `pnpm` (`corepack enable`)
- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`, `anvil`)
- Docker (for the containerized deploy)

## Setup

```bash
pnpm install                 # JS/TS workspaces
cp .env.example .env         # fill in RPC, LLM, 1delta, signer keys
forge build --root contracts # Solidity (installs solc 0.8.28 on first run)
```

## Common tasks

```bash
pnpm -r typecheck            # type-check all packages
pnpm -r lint                 # eslint
pnpm -r test                 # vitest
pnpm -r build                # build all packages
forge test --root contracts  # Solidity tests
docker compose config        # validate the deploy stack
```

## Stack

Solidity + Foundry · React + Vite + Tailwind + daisyUI · RainbowKit + wagmi + viem
(frontend) · Node/TS + Fastify + viem (backend) · Anthropic API (Claude,
`@anthropic-ai/sdk`) · 1delta API + Mantle RPC.

## Note for Claude Code on the web / restricted environments

This environment's network allowlist permits npm, GitHub, and the Anthropic API,
but **blocks the Mantle RPC, 1delta API, and `binaries.soliditylang.org`.**
Consequences:

- **Solidity compiler:** `forge build` cannot fetch solc from the Solidity binary
  server. Install it from GitHub releases instead (one-time per container):
  ```bash
  mkdir -p ~/.svm/0.8.28
  curl -sSL -o ~/.svm/0.8.28/solc-0.8.28 \
    https://github.com/ethereum/solidity/releases/download/v0.8.28/solc-static-linux
  chmod +x ~/.svm/0.8.28/solc-0.8.28
  forge build --root contracts --offline
  ```
- **On-chain work** (fork tests, `cast` calls, the agent's RPC/1delta calls)
  requires adding these hosts to the environment's network policy:
  `rpc.mantle.xyz` (+ mirrors), `api.1delta.io`. (`api.anthropic.com` is already
  allowed.)
