<p align="center"><img src="web/public/custos.svg" alt="Custos" width="120" /></p>

# Custos

**Custos is an AI risk-guardian vault on Mantle.** You deposit USDC; an autonomous AI
agent puts it to work earning tokenized-US-Treasury yield (Ondo **USDY**) over an Aave v3
USDC liquidity floor — and the moment RWA danger appears (a depeg, a stale oracle, an
issuer or regulatory shock) it **de-risks on-chain by itself**, rotating back to USDC
before losses land. Every move is bounded by **immutable on-chain guardrails**, and every
decision is recorded **with its evidence** under a verifiable **ERC-8004** identity — so
anyone can audit *what* the agent did and *why*, and prove on-chain that it beats simply
holding USDY through the dip.

---

## What is Custos, in simple terms

Think of it as a **savings account that defends itself.**

- You put in USDC (a dollar stablecoin).
- Custos earns yield from **short-term US Treasuries** (via Ondo's tokenized USDY) on top
  of on-chain lending (Aave) — aiming to beat just parking cash.
- A **24/7 AI agent** watches for trouble. If the Treasury token slips off its peg, its
  price oracle goes stale, or bad news breaks, the agent **automatically pulls the money
  back to safe USDC** — no human in the loop, no waiting for a multisig.
- It **can't go rogue.** Hard-coded on-chain rules cap how much risk it may take, and the
  agent can only ever *reduce* risk, never increase it.
- Everything is **on the public ledger, with receipts** — the reasoning plus the evidence
  behind each move — so you can verify it actually protected you.

The product isn't the yield (lots of things earn yield); the product is the **verifiable,
autonomous defense.**

---

## How it works

1. **Deposit** USDC into an ERC-4626 `YieldVault`.
2. The **agent** (ALLOCATOR role) allocates across four buckets — **IDLE** USDC,
   **Aave v3** USDC (liquidity floor), the **RWA yield core** (Ondo **USDY**, holdable
   as its rebasing $1 form **mUSD**), and the **AUSD** safety leg — always within
   **immutable on-chain guardrails**.
3. It continuously monitors **peg deviation, oracle freshness, and liquidity**
   (deterministic) and reads **attestations / regulatory news** (the LLM) for threats
   a threshold alone would miss.
4. On danger it calls **`deRisk`**: rotates USDY → USDC and emits a `DecisionRecorded`
   event with a `rationaleHash` + an IPFS evidence bundle (`decisionURI`).
5. An on-chain **`AgentBenchmark`** records the bps delta vs a **passive 100%-USDY
   holder** — the "can the AI actually beat passive?" answer, verifiable by anyone.

### Architecture

```
        deposit / withdraw (viem)          rebalance / deRisk  (ALLOCATOR, guardrail-gated)
 ┌───────────────┐   reads (wagmi)   ┌──────────────────────────────────────────────┐
 │   Web app     │◀─────────────────▶│                 Mantle (5000)                 │
 │ React · Vite  │                   │  YieldVault  (ERC-4626, asset = USDC)         │
 │ RainbowKit    │                   │   ├─ AaveV3Adapter   → Aave v3 (USDC floor)   │
 └──────┬────────┘                   │   ├─ UsdyAdapter     → 1delta Composer (USDC↔ │
        │ /snapshot /ask              │   │                     USDY) + Ondo mUSD     │
        │ /risk-score (x402)          │   │                     wrap/unwrap converter │
 ┌──────┴────────┐                    │   └─ AusdAdapter     → 1delta (USDC↔AUSD)     │
 │  Agent (TS)   │  rebalance/deRisk   │  Guardrails        (immutable limits)         │
 │ Fastify       │───────────────────▶│  AgentBenchmark    (decisions + passive Δ)    │
 │  risk engine  │                    │  ERC-8004 identity + reputation (canonical)   │
 │  LLM (SDK)    │◀── data (1delta    │  ERC-8183 job escrow + guardrail Evaluator    │
 │  validator    │     + Mantle RPC)  └──────────────────────────────────────────────┘
 │  executor     │   evidence → IPFS (decisionURI) · premium feeds via x402 (EIP-3009)
 └───────────────┘
```

The LLM **proposes**, a **deterministic validator** checks against guardrails before
signing, and **immutable on-chain `Guardrails`** are the final backstop. The model is
never the last line of defense. **1delta provides data + swap routing/quoting; the
calldata it returns executes only against the pinned 1delta Composer, under an
oracle-derived balance-delta `minOut`.**

---

## The AI agent

A standalone Node/TypeScript service — the vault's **ALLOCATOR** — is the brain. Each
cycle it:

1. **Reads ground truth on-chain** — USDY NAV from Ondo's `RWADynamicOracle`, the
   USDY/mUSD DEX spot (peg deviation), Aave reserve data, AUSD reserves, and the vault's
   own state.
2. **Runs a deterministic risk engine** — peg, oracle-freshness, liquidity and slippage
   checks that need no AI at all.
3. **Calls an LLM only where an algorithm can't help** — turning unstructured inputs
   (reserve attestations, proof-of-reserves reports, regulatory/issuer headlines, and
   x402-paid premium feeds) into a **bounded, structured risk verdict + plain-language
   rationale**, catching threats a pure threshold would miss.
4. **Proposes an allocation** that a deterministic validator re-checks against the
   guardrails *before signing* — immutable on-chain `Guardrails` are the final backstop.
5. **Executes within custody** — `rebalance` / `deRisk` on the vault — recording a
   `DecisionRecorded` event (rationale hash + IPFS evidence bundle) and an `AgentBenchmark`
   outcome vs a passive 100%-USDY holder.

**The AI can only tighten risk** — lower USDY weight, raise the risk level — never loosen a
guardrail or add exposure. On any LLM/API failure it falls back to the deterministic
allocation, so it degrades safely instead of stalling.

**Provider-agnostic LLM.** The agent talks to the model through the **Anthropic SDK**
(`@anthropic-ai/sdk`), so it runs against Anthropic's Claude **or any Anthropic-compatible
endpoint** via `ANTHROPIC_BASE_URL` — this deployment uses **[z.ai](https://z.ai)** (GLM).
To switch providers, change the base URL, key, and model name; nothing else changes.

---

## Contracts

### Contract architecture

How the on-chain pieces interact — who can call what, and what each adapter talks to:

```
   CALLERS                                                        EXTERNAL PROTOCOLS
   ───────                                                        ──────────────────
   Depositor ──── deposit / withdraw (USDC) ─────┐
   ALLOCATOR ──── rebalance / deRisk / convert ──┤   (agent hot key, guardrail-gated)
   GUARDIAN  ──── pause / kill / emergencyExit ──┤
   ADMIN     ──── setConfig / addStrategy ───────┤   (timelocked)
                                                 ▼
                  ┌─────────────────────────────────────────────────┐
                  │           YieldVault  (ERC-4626, asset = USDC)   │
                  │                                                  │
                  │   every move is CHECKED by  ─►  Guardrails       │  immutable limits +
                  │                                 (+ Roles)        │  depeg/oracle guard + timelock
                  │   every move is RECORDED in ─►  AgentBenchmark   │  decision + outcome ledger
                  └───────┬──────────────┬──────────────┬───────────┘
                          │ supply/        │ swap calldata│ swap calldata
                          │ withdraw       │ (minOut)     │ (minOut)
                          ▼                ▼              ▼
                    AaveV3Adapter     UsdyAdapter    AusdAdapter
                          │                │              │
                          ▼                ▼              ▼
                     Aave v3 pool    1delta Composer  1delta Composer
                                     Ondo RWADynamicOracle (NAV)
                                     Ondo mUSD converter (wrap/unwrap)

   Each adapter derives its own oracle-based balance-delta minOut — the Composer's
   reported output is never trusted, and swap output must land on the adapter or revert.

   Off the custody path (verifiable identity + economics):
     • ERC-8004 Identity + Reputation (canonical Mantle singletons) — agent identity & reputation
     • CustosJobEscrow + CustosDeRiskEvaluator (ERC-8183) — each de-risk as a guardrail-evaluated job
     • x402 (EIP-3009) — the agent sells GET /risk-score and pays for premium evidence feeds
```

### Core contracts

| Contract | Description |
|---|---|
| **`YieldVault`** | ERC-4626 vault (asset = USDC). `rebalance` and `deRisk` are the AI-powered on-chain functions, restricted to ALLOCATOR and guarded by `Guardrails`. Emits `DecisionRecorded` on every allocation change. |
| **`Guardrails`** | Immutable allocation limits: max weight per bucket, min liquidity buffer, max slippage, depeg/oracle-staleness guard, add-strategy timelock, pause/kill switch. Every post-bootstrap change is timelocked. The model is never the last line of defense — `Guardrails` is. |
| **`AgentBenchmark`** | On-chain decision ledger. Records each decision, its rationaleHash + decisionURI, and later the realized outcome bps delta vs a passive 100%-USDY holder. |
| **`AaveV3Adapter`** | Supplies and withdraws USDC on Aave v3 Mantle — the DeFi yield leg and instant-liquidity floor. Calls the Aave pool directly with on-chain `minOut`. |
| **`UsdyAdapter`** | USDC↔USDY swaps via the pinned 1delta Composer, oracle-derived balance-delta `minOut`. Also converts USDY↔mUSD via the Ondo Token Converter (`wrap`/`unwrap` on the mUSD contract). |
| **`AusdAdapter`** | USDC↔AUSD swaps via the same pinned 1delta Composer, oracle-derived `minOut`. The reserve-backed safety bucket. |
| **`CustosJobEscrow`** | ERC-8183 job escrow: each de-risk is modelled as a verifiable escrowed job. Outside the vault custody path — escrows per-job bounties, never vault deposits. |
| **`CustosDeRiskEvaluator`** | ERC-8183 evaluator. Its success criterion IS the deterministic guardrail check, feeding ERC-8004 reputation. |
| **`CustosIdentityRegistry`** | ERC-8004 fallback identity registry for environments where canonical singletons are unavailable. Production uses the canonical Mantle singletons. |
| **`CustosReputationRegistry`** | ERC-8004 fallback reputation registry. Same fallback rationale. |
| **`Guardrails` / `Roles`** | Role constants: `ADMIN`, `ALLOCATOR`, `GUARDIAN`. |
| **`AggregatorSwapLib`** | Library: enforces the balance-delta `minOut` pattern for 1delta Composer swap calldata. |

### Allocation buckets

| Id | Bucket | Asset | Role | Instant liquidity? |
|----|--------|-------|------|--------------------|
| 0 | `IDLE` | USDC | Always-available buffer | Yes |
| 1 | `AAVE` | aUSDC (Aave v3) | DeFi yield + liquidity floor | Yes (pool permitting) |
| 2 | `USDY` | USDY or mUSD | RWA yield core (~4.5% Treasury) | No (DEX unwind) |
| 3 | `AUSD` | AUSD | Reserve-backed escape hatch | Partial (DEX) |

USDY and mUSD are the two on-chain forms of the same RWA core — convertible 1:1-by-NAV
via the Ondo Token Converter (`wrap`/`unwrap` on the mUSD contract).

### Key guardrail parameters

| Parameter | Value | Meaning |
|---|---|---|
| `maxWeightBps[USDY]` | 6000 (60%) | Max allocation to the RWA core |
| `maxUsdyNotionalUsdc` | $5,000 | Absolute USDY cap (thin DEX depth on Mantle) |
| `minInstantLiquidityBps` | 1500 (15%) | IDLE + Aave-withdrawable ≥ 15% TVL at all times |
| `maxSlippageBps` | 50 (0.5%) | Per-swap `minOut` tolerance |
| `tvlCap` | $50,000 | Vault deposit cap |
| `pegDeRiskBps` | 100 (1.0%) | USDY DEX vs oracle NAV deviation → force de-risk |
| `oracleMaxAge` | 100800s (~28h) | Oracle range expiry → block + de-risk |

See [`docs/spec.md`](./docs/spec.md) §1 for the full parameter table.

---

## Deployed addresses

### Mantle mainnet (chain ID 5000)

**Custos contracts** — deployed 2026-06-13:

| Contract | Address | Explorer |
|---|---|---|
| `Guardrails` | `0x90C52C8Bd9df235b012e1920E5E8bb43B4B16e55` | [mantlescan](https://mantlescan.xyz/address/0x90C52C8Bd9df235b012e1920E5E8bb43B4B16e55) |
| `YieldVault` | `0xc4dc4Bc6e7bF61300747b017C08Ae86b63F08d3F` | [mantlescan](https://mantlescan.xyz/address/0xc4dc4Bc6e7bF61300747b017C08Ae86b63F08d3F) |
| `AgentBenchmark` | `0xf1feCfc87fe4613AbCcd6B591884Ce12f272cb87` | [mantlescan](https://mantlescan.xyz/address/0xf1feCfc87fe4613AbCcd6B591884Ce12f272cb87) |
| `AaveV3Adapter` | `0x158FDE048f7ecEDE51580B1e990dcaCB3125C0b6` | [mantlescan](https://mantlescan.xyz/address/0x158FDE048f7ecEDE51580B1e990dcaCB3125C0b6) |
| `UsdyAdapter` | `0xFe58aaB3C14BB2Af5555c6753b2971d0ADfBfd9f` | [mantlescan](https://mantlescan.xyz/address/0xFe58aaB3C14BB2Af5555c6753b2971d0ADfBfd9f) |
| `AusdAdapter` | `0x0E695Cdb8010Ca7D75F90860eCc63a569888484e` | [mantlescan](https://mantlescan.xyz/address/0x0E695Cdb8010Ca7D75F90860eCc63a569888484e) |

Authoritative record: [`deployments/5000.json`](./deployments/5000.json) and
[`packages/shared/src/deployments.ts`](./packages/shared/src/deployments.ts).

**Integrated protocol addresses:**

| Token / venue | Address | Explorer |
|---|---|---|
| USDC | `0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9` | [mantlescan](https://mantlescan.xyz/address/0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9) |
| Ondo USDY | `0x5bE26527e817998A7206475496fDE1E68957c5A6` | [mantlescan](https://mantlescan.xyz/address/0x5bE26527e817998A7206475496fDE1E68957c5A6) |
| Ondo mUSD (Token Converter) | `0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3` | [mantlescan](https://mantlescan.xyz/address/0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3) |
| Agora AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | [mantlescan](https://mantlescan.xyz/address/0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a) |
| Ondo `RWADynamicOracle` | `0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f` | [mantlescan](https://mantlescan.xyz/address/0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f) |
| 1delta Composer (pinned) | `0x5C019a146758287C614FE654CaEC1ba1CaF05F4E` | [mantlescan](https://mantlescan.xyz/address/0x5C019a146758287C614FE654CaEC1ba1CaF05F4E) |
| Aave v3 `PoolAddressesProvider` | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | [mantlescan](https://mantlescan.xyz/address/0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f) |
| ERC-8004 Identity registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | [mantlescan](https://mantlescan.xyz/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| ERC-8004 Reputation registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | [mantlescan](https://mantlescan.xyz/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |

---

## How to run locally

### Prerequisites

- Node ≥ 22 and `pnpm` (`corepack enable`)
- [Foundry](https://book.getfoundry.sh/) (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Docker (for the containerized production deploy)

### 1 — Install and configure

```bash
git clone https://github.com/0xmaxyz/custos && cd custos
pnpm install                   # JS/TS workspaces
cp .env.example .env           # fill in variables (see below)
```

Minimum `.env` for read-only / dev mode:

```bash
MANTLE_RPC_URL=https://rpc.mantle.xyz   # required for on-chain reads
ANTHROPIC_API_KEY=                       # LLM key (Anthropic, or any compatible provider)
ANTHROPIC_BASE_URL=                      # optional — point the Anthropic SDK at e.g. z.ai
# Leave ALLOCATOR_PRIVATE_KEY and VAULT_ADDRESS blank for read-only mode
```

All env variables are documented in [`.env.example`](./.env.example), grouped by
concern: chain/RPC, LLM, 1delta data, signer keys, IPFS, alerts, x402, and frontend.

### 2 — Build contracts

```bash
forge build --root contracts   # compiles Solidity (downloads solc 0.8.35 on first run)
```

> **Restricted environment (no public internet):** install solc manually:
> ```bash
> mkdir -p ~/.svm/0.8.35
> curl -sSL -o ~/.svm/0.8.35/solc-0.8.35 \
>   https://github.com/ethereum/solidity/releases/download/v0.8.35/solc-static-linux
> chmod +x ~/.svm/0.8.35/solc-0.8.35
> forge build --root contracts --offline
> ```

### 3 — Start the agent

```bash
pnpm -C agent dev   # Fastify dev server with hot reload on :3000
```

The agent runs **read-only** without `ALLOCATOR_PRIVATE_KEY` / `VAULT_ADDRESS` — useful
for monitoring and testing `/snapshot` / `/ask` without any custody risk. To enable the
autonomous rebalance/de-risk loop, set both in `.env` and point `VAULT_ADDRESS` at a
deployed `YieldVault`.

Endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/snapshot` | Live market state + risk flags |
| `POST` | `/ask` | Conversational Q&A grounded in snapshot + recent decisions |
| `GET` | `/risk-score` | x402-gated RWA risk score |

### 4 — Start the frontend

```bash
pnpm -C web dev   # Vite dev server on :5173
```

The web app runs in **demo mode** (typed fixture data) without `VITE_VAULT_ADDRESS`. To
point at a live deployment, set in `.env`:

```bash
VITE_VAULT_ADDRESS=0xc4dc4Bc6e7bF61300747b017C08Ae86b63F08d3F   # mainnet vault
VITE_AGENT_API_URL=http://localhost:3000                          # agent service
VITE_AGENT_ID=                                                    # ERC-8004 agent NFT id
VITE_WALLETCONNECT_ID=                                            # optional
```

### 5 — Deploy to mainnet / testnet

See [`docs/deploy.md`](./docs/deploy.md) for the full end-to-end runbook: fork
rehearsal, contract broadcast, ERC-8004 registration, Docker/Caddy stack, and the
post-deploy smoke-test checklist.

---

## Tests

### Solidity (Foundry)

```bash
# Offline unit tests — no RPC needed, runs in CI
forge test --root contracts --no-match-contract Fork

# Fork tests — requires MANTLE_RPC_URL (Mantle mainnet RPC)
forge test --root contracts --match-contract Fork --fork-url $MANTLE_RPC_URL

# Verbose output for a single test
forge test --root contracts -vvv --match-test test_deRisk
```

Test files are in `contracts/test/`:
- `Phase*.t.sol` — offline unit tests (guardrails, vault accounting, adapter math)
- `ForkPhase*.t.sol` — fork integration tests against live Mantle state (adapter swaps,
  Aave interactions, Ondo oracle/converter wiring)

### TypeScript (Vitest)

```bash
pnpm -C agent test      # agent: risk engine, guardrail validator, LLM client
pnpm -r test            # all TS packages

# Type-check and lint
pnpm -r typecheck
pnpm -r lint
```

### Full build

```bash
pnpm -r build           # build all TS/React packages
docker compose config   # validate the Docker deploy stack
```

---

## Design rationale

### What RWA and what data

- **Yield core:** Ondo **USDY** — a tokenized note backed by short-term US Treasuries —
  valued by Ondo's on-chain `RWADynamicOracle` (NAV). Holdable as USDY or its rebasing
  $1 form **mUSD** (converted 1:1-by-NAV via the Ondo Token Converter).
- **Safety leg:** Agora **AUSD**, reserve-backed with on-chain Chaos Labs proof-of-reserves.
- **Liquidity floor:** USDC supplied to **Aave v3** on Mantle.
- **Ground-truth reads (RPC — accounting source of truth):** USDY NAV (`RWADynamicOracle`),
  USDY/mUSD DEX spot (peg deviation), Aave reserve data, AUSD proof-of-reserves.
- **Breadth + routing (1delta API):** Aave pools/IRM/yields and swap quotes — data and
  route hints only, never execution.
- **Unstructured evidence for the LLM:** Ondo reserve attestations, AUSD PoR reports,
  regulatory/issuer headlines — including **x402-paid premium feeds** whose settlement
  receipts are pinned into the decision evidence bundle.

---

## Repo layout

```
contracts/         Foundry (Solidity) — vault, adapters, guardrails, benchmark, ERC-8004/8183
agent/             Node + TS + Fastify — risk engine, LLM layer, validator, executor, x402
web/               React + Vite + Tailwind + daisyUI — dashboard, risk-guardian feed, agent
packages/shared/   Shared types, verified addresses, token metadata, guardrail constants
deployments/       Deployment records by chain id (5000.json = mainnet)
docs/              Architecture, spec, UI design, deploy runbook, contributor guide
```

See each package's `README.md` for per-component setup and source structure, and
[`docs/`](./docs/README.md) for in-depth design and specification documents.

## Stack

Solidity + Foundry · React + Vite + Tailwind + daisyUI · RainbowKit + wagmi + viem
(frontend) · Node/TS + Fastify + viem (backend) · Anthropic SDK
(`@anthropic-ai/sdk`; Claude or any compatible endpoint, e.g. z.ai/GLM) · 1delta API +
Mantle RPC.
