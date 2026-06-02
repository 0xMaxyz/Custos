# Custos

**AI risk-guardian real-yield account on Mantle.** Deposit USDC; an AI agent earns
tokenized-Treasury (USDY) yield with an Aave v3 USDC liquidity floor, and
**autonomously de-risks on-chain** into AUSD/USDC when RWA danger appears (depeg,
oracle staleness, issuer/regulatory shock) — recording every decision **and its
evidence** on-chain under an ERC-8004 identity.

> **One-line pitch:** Custos earns tokenized-Treasury yield and **autonomously
> de-risks on-chain before RWA danger hits** — recording every decision and its
> evidence under a verifiable ERC-8004 identity, and proving on-chain that it beats a
> passive USDY holder. The verifiable autonomous defense — not the swap-to-USDY — is
> the product.

**Track:** AI × RWA (Application path), exclusively supported by Mantle. See
[`PLAN.md`](./PLAN.md), [`ROADMAP.md`](./ROADMAP.md), [`SPEC.md`](./SPEC.md),
[`AGENTS.md`](./AGENTS.md), and [`UI.md`](./UI.md).

## How it works

1. **Deposit** USDC into an ERC-4626 `YieldVault`.
2. The **agent** (ALLOCATOR role) allocates across four buckets — **IDLE** USDC,
   **Aave v3** USDC (liquidity floor), the **RWA yield core** (Ondo **USDY**, holdable
   as its rebasing $1 form **mUSD**), and the **AUSD** safety leg — always within
   **immutable on-chain guardrails**.
3. It continuously monitors **peg deviation, oracle freshness, liquidity** (deterministic)
   and reads **attestations / regulatory news** (the LLM) for threats a threshold misses.
4. On danger it calls **`deRisk`**: rotates USDY → AUSD/USDC and emits a
   **`DecisionRecorded`** event with a `rationaleHash` + an IPFS evidence bundle (`decisionURI`).
5. An on-chain **`AgentBenchmark`** records the bps delta vs a **passive 100%-USDY
   holder** — the "can the AI actually beat passive?" answer, verifiable by anyone.

### Architecture

```
        deposit / withdraw (viem)          rebalance / deRisk  (ALLOCATOR, guardrail-gated)
 ┌───────────────┐   reads (wagmi)   ┌──────────────────────────────────────────────┐
 │   Web app     │◀─────────────────▶│                 Mantle (5000 / 5003)          │
 │ React · Vite  │                   │  YieldVault  (ERC-4626, asset = USDC)         │
 │ RainbowKit    │                   │   ├─ AaveV3Adapter   → Aave v3 (USDC floor)   │
 └──────┬────────┘                   │   ├─ UsdyAdapter     → Odos aggregator (USDC↔ │
        │ /snapshot /ask              │   │                     USDY) + Ondo mUSD     │
        │ /risk-score (x402)          │   │                     wrap/unwrap converter │
 ┌──────┴────────┐                    │   └─ AusdAdapter     → Odos (USDC↔AUSD)       │
 │  Agent (TS)   │  rebalance/deRisk   │  Guardrails        (immutable limits)         │
 │ Fastify       │───────────────────▶│  AgentBenchmark    (decisions + passive Δ)    │
 │  risk engine  │                    │  ERC-8004 identity + reputation (canonical)   │
 │  LLM (Claude) │◀── data (1delta    │  ERC-8183 job escrow + guardrail Evaluator    │
 │  validator    │     + Mantle RPC)  └──────────────────────────────────────────────┘
 │  executor     │   evidence → IPFS (decisionURI) · premium feeds via x402 (EIP-3009)
 └───────────────┘
```

The LLM **proposes**, a **deterministic validator** checks against guardrails before
signing, and **immutable on-chain `Guardrails`** are the final backstop. The model is
never the last line of defense. **1delta is data + swap routing/quoting only — never in
the custody/execution path.**

## The three submission answers (AI × RWA)

### 1 · What RWA, and what data drives it

- **Yield core:** Ondo **USDY** — a tokenized note backed by short-term US Treasuries +
  bank deposits — valued by Ondo's on-chain **`RWADynamicOracle`** (NAV). Holdable as
  USDY *or* its rebasing $1 form **mUSD** (converted 1:1-by-NAV via Ondo's on-chain
  `wrap`/`unwrap`). **Safety leg:** Agora **AUSD**, a reserve-backed $1 stablecoin with
  on-chain proof-of-reserves. **Liquidity floor:** USDC supplied to **Aave v3**.
- **Ground-truth reads (Mantle RPC — accounting source of truth):** USDY NAV via
  `RWADynamicOracle`, USDY/mUSD DEX spot (peg deviation), Aave reserve data, AUSD
  proof-of-reserves.
- **Breadth + routing (1delta API):** Aave pools/IRM/yields and swap **quotes** (it
  aggregates Odos/Eisen/Nordstern) — used only for data + route hints, never execution.
- **Unstructured evidence for the LLM:** Ondo reserve attestations, AUSD PoR reports,
  and regulatory/issuer news — including **x402-paid premium feeds** whose settlement
  receipts are pinned into the decision evidence bundle ("the agent paid for the
  evidence it acted on").

### 2 · The role of the AI (and where we deliberately don't use it)

- The LLM (Anthropic **Claude**) owns exactly the task an algorithm can't: turning
  **unstructured documents + headlines** (an attestation finding, an issuer
  redemption-pause review) into a **bounded, structured risk verdict + a plain-language
  rationale**. This is the hero path — catching a threat a pure threshold would miss.
- **The AI may only _tighten_ risk** (lower USDY weight / raise the risk level). It can
  never loosen a guardrail or raise exposure.
- **No AI-washing — these stay deterministic:** yield optimization, peg/oracle
  deviation, liquidity buffers, slippage, and execution. The pipeline is
  **LLM proposes → deterministic validator checks → immutable on-chain `Guardrails`
  backstop**; on any API failure the agent falls back to the deterministic allocation.
- **Verifiable, not a black box:** every decision + evidence is recorded on-chain
  (a `DecisionRecorded` event + IPFS `decisionURI`); the agent has an **ERC-8004 identity** and accrues
  **reputation**; each de-risk is modelled as an **ERC-8183 escrowed job whose Evaluator
  _is_ the deterministic guardrail check**; and `AgentBenchmark` records the bps delta
  vs a passive USDY holder.

### 3 · How it's realized on Mantle

- **Mantle-only** (mainnet **5000** / testnet **5003**) — no other execution chains.
- Built on Mantle-native RWA + DeFi: Ondo **USDY/mUSD** + `RWADynamicOracle` (+ on-chain
  converter), Agora **AUSD** (+ Chaos Labs PoR), **Aave v3** on Mantle, and the pinned
  **Odos** aggregator. USDY/AUSD liquidity on Mantle is thin and fragmented (~$1.5k
  across pools), so the adapter splits orders across venues and enforces an
  **oracle-derived balance-delta `minOut`** (the router's output is never trusted) — the
  reason an aggregator is used inside the custody boundary at all.
- The agent registers against the **canonical ERC-8004 singletons live on Mantle**; the
  **AI-powered on-chain function** (`rebalance`/`deRisk`, ALLOCATOR-only, guardrail-gated)
  is callable on-chain and emits verifiable `DecisionRecorded` events.
- Addendum agent-economy layers — **x402** micropayments (EIP-3009/USDC) for paid data +
  a sellable risk-score endpoint, and **ERC-8183** job escrow — stay **outside the vault
  custody path** (per-job bounties, never user deposits).

## Monorepo layout

```
contracts/         Foundry (Solidity) — vault, adapters, guardrails, benchmark, ERC-8004/8183
agent/             Node + TS + Fastify — risk engine, LLM layer, validator, executor, x402
web/               React + Vite + Tailwind + daisyUI — dashboard, risk-guardian feed, agent
packages/shared/   Shared types, verified addresses, token metadata, guardrail constants
```

## Deployed addresses

**Mantle Sepolia testnet (5003)** — Custos contracts (see `packages/shared/src/deployments.ts`):

| Contract       | Address |
| -------------- | ------- |
| Guardrails     | `0xc3D287D35DCb6945d93c246dbE610C9AF5106E9c` |
| YieldVault     | `0xC2009De9C72EfAfAeeD8Ceac2960A9B6eFEeAc85` |
| AgentBenchmark | `0xCd3EcF4d092eE73Ac4882c61b5f114588B6B122a` |
| UsdyAdapter    | `0xd420Bdf2a7eab8F86DE12f06728342b7243101C9` |
| USDC (mock)    | `0x6969D583f2b2e68c2f6f1A2E883aeC4dA96A3297` |
| USDY (mock)    | `0x921689faCB514812F671194Db21014109354B5f6` |

_(AaveV3Adapter skipped on testnet — no Aave v3 pool on Mantle Sepolia.)_

**Mantle mainnet (5000)** — verified protocol addresses the adapters integrate:

| Token / venue | Address |
| ------------- | ------- |
| USDC | `0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9` |
| Ondo USDY | `0x5bE26527e817998A7206475496fDE1E68957c5A6` |
| Ondo mUSD (wrap/unwrap converter) | `0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3` |
| Agora AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` |
| Ondo `RWADynamicOracle` | `0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f` |
| Odos aggregator router | `0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745` |
| Aave v3 `PoolAddressesProvider` | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` |
| ERC-8004 Identity (canonical) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation (canonical) | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

> **Custos mainnet contracts:** pending the mainnet deploy (ROADMAP 5.2 — needs a
> Mantle RPC + deployer/ALLOCATOR keys). Addresses land in `deployments.ts` +
> `deployments/5000.json` after broadcast + mantlescan verification.

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

All configuration is documented in [`.env.example`](./.env.example), grouped by concern:
**chain/RPC** (`MANTLE_RPC_URL`, …), **data** (`ONEDELTA_API_KEY`), **LLM**
(`ANTHROPIC_API_KEY`), **signer** (`ALLOCATOR_PRIVATE_KEY` — the guardrail-bounded hot
key), **IPFS**, **deploy** (`DEPLOYER_PRIVATE_KEY`, testnet token addresses), **alerts**
(Telegram/Discord), **x402** (`X402_*`), and **frontend** (`VITE_*`). Every path that
needs a secret is optional except `MANTLE_RPC_URL`, so read-only/dev runs need almost nothing.

## Run it

```bash
pnpm -C agent dev            # agent API: /health /snapshot /ask /risk-score (x402)
pnpm -C web dev             # web app (Vite dev server)

# Solidity tests
forge test --root contracts --no-match-contract Fork                   # offline unit tests
forge test --root contracts --match-contract Fork --fork-url $MANTLE_RPC_URL  # fork tests only (needs a Mantle RPC)
```

The agent runs read-only without an `ALLOCATOR_PRIVATE_KEY`/`VAULT_ADDRESS`; set those
to enable the autonomous rebalance/de-risk loop. The web app serves typed fixtures until
`VITE_VAULT_ADDRESS` points at a deployment, then reads live.

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

## Submission checklist (Project Deployment Award)

- [x] Smart contracts deployed on Mantle (testnet 5003; mainnet pending keys).
- [ ] Contracts **verified on mantlescan** (with the mainnet deploy).
- [x] An **AI-powered on-chain function** (`rebalance`/`deRisk`, ALLOCATOR-gated, emits `DecisionRecorded`).
- [ ] Frontend demo **publicly accessible** (ROADMAP 6.1 — Docker/Caddy).
- [ ] **Deployment address** in the DoraHacks submission.
- [ ] **Demo video ≥ 2 min** (ROADMAP 6.3) — deposit → AI reads a signal → de-risk → baseline delta.
- [x] Open-source repo with **README** (setup · architecture · deployed addresses · the 3 answers).
- [x] One-line pitch + the three answers (above).

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
