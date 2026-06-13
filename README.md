# Custos

**AI risk-guardian real-yield account on Mantle.** Deposit USDC; an AI agent earns
tokenized-Treasury (USDY) yield with an Aave v3 USDC liquidity floor, and
**autonomously de-risks on-chain** to USDC (AUSD as a guardian-managed escape hatch)
when RWA danger appears — recording every decision **and its evidence** on-chain under
a verifiable ERC-8004 identity.

> **One-line pitch:** Custos earns tokenized-Treasury yield and **autonomously de-risks
> on-chain before RWA danger hits** — recording every decision and its evidence under a
> verifiable ERC-8004 identity, and proving on-chain that it beats a passive USDY holder.
> The verifiable autonomous defense — not the swap-to-USDY — is the product.

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
 │   Web app     │◀─────────────────▶│                 Mantle (5000 / 5003)          │
 │ React · Vite  │                   │  YieldVault  (ERC-4626, asset = USDC)         │
 │ RainbowKit    │                   │   ├─ AaveV3Adapter   → Aave v3 (USDC floor)   │
 └──────┬────────┘                   │   ├─ UsdyAdapter     → 1delta executor (USDC↔ │
        │ /snapshot /ask              │   │                     USDY) + Ondo mUSD     │
        │ /risk-score (x402)          │   │                     wrap/unwrap converter │
 ┌──────┴────────┐                    │   └─ AusdAdapter     → 1delta (USDC↔AUSD)     │
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

---

## Contracts

### Core contracts

| Contract | Description |
|---|---|
| **`YieldVault`** | ERC-4626 vault (asset = USDC). `rebalance` and `deRisk` are the AI-powered on-chain functions, restricted to ALLOCATOR and guarded by `Guardrails`. Emits `DecisionRecorded` on every allocation change. |
| **`Guardrails`** | Immutable allocation limits: max weight per bucket, min liquidity buffer, max slippage, depeg/oracle-staleness guard, add-strategy timelock, pause/kill switch. Every post-bootstrap change is timelocked. The model is never the last line of defense — `Guardrails` is. |
| **`AgentBenchmark`** | On-chain decision ledger. Records each decision, its rationaleHash + decisionURI, and later the realized outcome bps delta vs a passive 100%-USDY holder. |
| **`AaveV3Adapter`** | Supplies and withdraws USDC on Aave v3 Mantle — the DeFi yield leg and instant-liquidity floor. Calls the Aave pool directly with on-chain `minOut`. |
| **`UsdyAdapter`** | USDC↔USDY swaps via the pinned 1delta swap executor, oracle-derived balance-delta `minOut`. Also converts USDY↔mUSD via the Ondo Token Converter (`wrap`/`unwrap` on the mUSD contract). |
| **`AusdAdapter`** | USDC↔AUSD swaps via the same pinned 1delta swap executor, oracle-derived `minOut`. The reserve-backed safety bucket. |
| **`CustosJobEscrow`** | ERC-8183 job escrow: each de-risk is modelled as a verifiable escrowed job. Outside the vault custody path — escrows per-job bounties, never vault deposits. |
| **`CustosDeRiskEvaluator`** | ERC-8183 evaluator. Its success criterion IS the deterministic guardrail check, feeding ERC-8004 reputation. |
| **`CustosIdentityRegistry`** | ERC-8004 fallback identity registry for environments where canonical singletons are unavailable. Production uses the canonical Mantle singletons. |
| **`CustosReputationRegistry`** | ERC-8004 fallback reputation registry. Same fallback rationale. |
| **`Guardrails` / `Roles`** | Role constants: `ADMIN`, `ALLOCATOR`, `GUARDIAN`. |
| **`AggregatorSwapLib`** | Library: enforces the balance-delta `minOut` pattern for 1delta swap calldata. |

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
| 1delta swap executor (pinned) | `0x5C019a146758287C614FE654CaEC1ba1CaF05F4E` | [mantlescan](https://mantlescan.xyz/address/0x5C019a146758287C614FE654CaEC1ba1CaF05F4E) |
| Aave v3 `PoolAddressesProvider` | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | [mantlescan](https://mantlescan.xyz/address/0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f) |
| ERC-8004 Identity registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | [mantlescan](https://mantlescan.xyz/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| ERC-8004 Reputation registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | [mantlescan](https://mantlescan.xyz/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |

### Mantle Sepolia testnet (chain ID 5003)

| Contract | Address |
|---|---|
| `Guardrails` | `0xc3D287D35DCb6945d93c246dbE610C9AF5106E9c` |
| `YieldVault` | `0xC2009De9C72EfAfAeeD8Ceac2960A9B6eFEeAc85` |
| `AgentBenchmark` | `0xCd3EcF4d092eE73Ac4882c61b5f114588B6B122a` |
| `UsdyAdapter` | `0xd420Bdf2a7eab8F86DE12f06728342b7243101C9` |
| USDC (mock) | `0x6969D583f2b2e68c2f6f1A2E883aeC4dA96A3297` |
| USDY (mock) | `0x921689faCB514812F671194Db21014109354B5f6` |

_(AaveV3Adapter and AusdAdapter are skipped on testnet — no Aave v3 pool or thin AUSD
liquidity on Mantle Sepolia.)_

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
ANTHROPIC_API_KEY=                       # required for LLM rationale (agent hero path)
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

### The role of AI (and where we deliberately don't use it)

The LLM (Anthropic **Claude**) owns exactly the task an algorithm can't: turning
**unstructured documents + headlines** into a **bounded, structured risk verdict +
plain-language rationale**. This is the hero path — catching a threat a pure threshold
would miss.

- **The AI may only tighten risk** — lower USDY weight, raise the risk level. It can
  never loosen a guardrail or raise exposure.
- **These stay deterministic:** yield optimization, peg/oracle deviation, liquidity
  buffers, slippage, and execution.
- **The pipeline:** LLM proposes → deterministic validator checks → immutable on-chain
  `Guardrails` backstop. On any API failure the agent falls back to the deterministic
  allocation.
- **Verifiable:** every decision + evidence is recorded on-chain (`DecisionRecorded`
  event + IPFS `decisionURI`); the agent holds an ERC-8004 identity and accrues
  reputation; each de-risk is an ERC-8183 escrowed job whose Evaluator IS the
  deterministic guardrail check.

### Why Mantle

- **Mantle-only** (mainnet 5000 / testnet 5003) — no other execution chains.
- Built on Mantle-native RWA + DeFi: Ondo USDY/mUSD + `RWADynamicOracle`, Agora AUSD
  + Chaos Labs PoR, Aave v3 on Mantle, and the pinned 1delta swap executor.
- USDY/AUSD liquidity on Mantle is thin and fragmented (~$1.5k across pools), so the
  adapters enforce an **oracle-derived balance-delta `minOut`** on every swap — the
  aggregator's output is never trusted.
- The agent registers against the **canonical ERC-8004 singletons live on Mantle**.

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
(frontend) · Node/TS + Fastify + viem (backend) · Anthropic API (Claude,
`@anthropic-ai/sdk`) · 1delta API + Mantle RPC.
