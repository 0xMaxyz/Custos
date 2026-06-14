# Custos — Architecture & Design

> An AI risk-guardian real-yield account on Mantle. Users deposit USDC; an AI agent earns
> tokenized-Treasury (USDY) yield while continuously watching real-world RWA risk and
> **autonomously de-risking on-chain** — rotating to instantly-liquid USDC (with a
> reserve-backed AUSD escape hatch for USDC-issuer risk) when danger appears. Every decision and its triggering
> evidence are recorded on-chain under an ERC-8004 agent identity.

---

## 1. Product

**One-liner:** _Set-and-forget real-yield on tokenized US Treasuries, with an AI that watches the risks a stablecoin holder can't — and defends your money on-chain, verifiably._

**Target user:** Non-US retail seeking safe dollar yield without babysitting RWA risk, and small DAO/treasuries wanting a productive, defensible cash position with an auditable decision trail.

**JTBD:** _"Earn real-asset-backed yield on my dollars, automatically protect me from RWA-specific tail risks (depeg, oracle/issuer/regulatory events), and prove every move was justified."_

**Why it's not "just a USDY wrapper":** the swap-to-USDY is only the resting state. The product is the **autonomous, verifiable management and defense** around it: risk-aware allocation, automatic de-risking, and an on-chain evidence ledger. Remove the AI and the product can't read an attestation or a regulatory headline — the oracle-deviation trigger is deterministic, but the unstructured-signal path isn't.

---

## 2. AI vs algorithm split

We do **not** put AI where a deterministic algorithm is better. The AI is the **risk guardian**, not a black box that touches money directly.

**Deterministic / on-chain (algorithmic):** yield & APY math, allocation under constraints, peg/NAV deviation thresholds (oracle vs DEX spot), oracle-staleness check, liquidity-buffer sizing, slippage caps, guardrail enforcement, execution. The deterministic de-risk trigger (USDY DEX price vs oracle NAV deviation) is deliberately algorithmic — it doesn't need the AI.

**AI / LLM — only where it genuinely beats a threshold:**
1. **Unstructured → structured RWA risk signals** ← **the hero path.** Ondo/USDY monthly attestations, AUSD proof-of-reserves status, sanctions/regulatory/issuer headlines, Treasury-rate regime context. A threshold can't read a PDF or a news wire. This is the only path where removing the AI leaves a real gap.
2. **Explainability** — human-readable rationale + cited evidence for every action, recorded on-chain.
3. **Judgment on novel/ambiguous issuer or regulatory events** — always bounded by on-chain guardrails; the AI may only tighten risk, never loosen it.
4. **Conversational UX** — "why am I in AUSD right now?", "what changed today?".

**Safety model:** the LLM **proposes** target weights + a de-risk verdict; a **deterministic validator** checks the proposal against guardrails **before** signing; **timelocked on-chain guardrails** are the final backstop. The model is never the last line of defense.

---

## 3. Architecture

### 3.1 Assets & allocation buckets

| Id | Bucket | Role | Instantly liquid? |
|----|--------|------|-------------------|
| 0 | `IDLE` | USDC held in vault | Yes |
| 1 | `AAVE` | USDC supplied to Aave v3 | Yes (pool liquidity permitting) |
| 2 | `USDY` | RWA yield core — USDY or mUSD (Ondo; convertible via Ondo Token Converter) | No (DEX unwind) |
| 3 | `AUSD` | Reserve-backed escape hatch (guardian-managed; not an autonomous de-risk target) | Partial (DEX) |

- **USDY / mUSD (Ondo)** — RWA yield core (tokenized US Treasuries, ~4.5%). USDY is NAV/price-accruing; **mUSD** is its $1-pegged rebasing form on Mantle. The two are convertible on-chain via the **Ondo Token Converter** (the mUSD contract's `wrap`/`unwrap`), so the vault treats them as a single bucket.
- **Aave v3 USDC supply** — DeFi-yield leg **and** instant withdrawal liquidity (deep, redeemable on demand).
- **Idle USDC buffer** — instant small withdrawals.
- **AUSD (Agora)** — escape-hatch leg for USDC-issuer risk (reserve-backed: cash + T-bills + repo; on-chain proof-of-reserves). Guardian-managed: the autonomous de-risk lands in USDC; rotating onward to AUSD is a deliberate (manual/guardian) action.

### 3.2 The managed-allocation mechanism

1. User deposits **USDC**, receives ERC-4626 **shares**.
2. The AI sets **target weights** across the buckets from (a) the **yield spread** (USDY Treasury yield vs Aave supply APY, risk-adjusted) and (b) **RWA risk signals**.
3. **Yield reaches users via share-price appreciation** (USDY NAV accrual + Aave interest) — no rebasing, no claim step.
4. **Risk-guardian action:** on a danger signal (USDY DEX price vs `RWADynamicOracle` NAV deviation = depeg, oracle staleness, attestation/regulatory shock), the agent **auto-rotates out of USDY into USDC** (the instantly-liquid safe state), or **pauses**, and writes the decision + **evidence hash/URI** on-chain.
5. **Withdrawals** are served from **idle + Aave first** (instant); only large redemptions unwind USDY via DEX. The buffer is sized so normal withdrawals never wait on USDY liquidity.

### 3.3 Smart contracts (Foundry)

- **`YieldVault`** — ERC-4626, asset = **USDC**. `rebalance(targetWeights, decisionURI, rationaleHash)` is the AI-powered on-chain function, callable **only by the ALLOCATOR role**, emitting a `DecisionRecorded` event.
- **Strategy adapters (trustless, protocol-direct execution):**
  - `UsdyAdapter` — USDC↔USDY/mUSD via the pinned 1delta swap executor, oracle-derived `minOut`, blocklist-aware; USDY↔mUSD conversion via Ondo `wrap`/`unwrap`.
  - `AaveV3Adapter` — supply/withdraw USDC on Aave v3 Mantle.
  - `AusdAdapter` — USDC↔AUSD via the pinned 1delta swap executor, oracle-derived `minOut`.
- **`Guardrails`** (timelocked params — one-shot bootstrap config at deploy, then **every** change queues behind the on-chain timelock, with a 1h hard floor on the delay and an explicit `cancelConfig`): max weight per bucket, min idle/Aave liquidity buffer, max slippage, token/venue whitelist, max rebalance frequency, per-tx caps, pause/kill switch, add-strategy timelock, and a **depeg/oracle-deviation guard** that can force de-risk.
- **`AgentBenchmark`** — logs each decision + the triggering evidence + later the realized outcome (APY, drawdown avoided) → the **on-chain benchmarking** record vs a passive 100%-USDY holder.
- **ERC-8004 registries** — register the agent in Identity (ERC-721) + Reputation registries. Uses the canonical 0x8004 singletons deployed on Mantle.
- **`CustosJobEscrow` / `CustosDeRiskEvaluator`** — ERC-8183 escrowed jobs: each de-risk is modelled as a verifiable job whose Evaluator is the deterministic guardrail check. Outside the vault custody path.

### 3.4 Backend AI agent (Node.js + TypeScript + Fastify)

- **Data ingestion (read):** 1delta API (Aave/market data on Mantle — rates, utilization, TVL, IRM curves) + **direct RPC** for held-asset ground-truth (Aave position, USDY `RWADynamicOracle` NAV, USDY DEX price, AUSD proof-of-reserves).
- **RPC efficiency (avoids public-RPC 429s):** the per-cycle vault reads are aggregated through **Multicall3** (one `eth_call`, not ~13); the oracle NAV is read once per snapshot (feeds both peg and APY); the always-reverting `currentRange()` is probed once per process; and the 30s loop runs a **cheap breach check** (peg/oracle only) that escalates to a full vault snapshot only on a real breach (the 60m periodic loop does the full yield rebalance). `MANTLE_RPC_URL` accepts several comma-separated providers → a viem `fallback` transport that fails over on 429.
- **1delta credit efficiency:** the USDY peg price uses a **two-tier** read — the RPC-free `token/prices` feed for routine monitoring, escalating to the precise (RPC-on-1delta) `swap/spot` quote only once the peg reaches the warn band, so every peg flag / de-risk decision is still made on the authoritative executable quote while calm markets cost zero `swap/spot` calls. Per-source cache TTLs (DEX spot 30s, slow-moving Aave market data 5min) cut repeat calls further.
- **Deterministic risk engine:** yield-spread calc, peg/NAV deviation, oracle-staleness check, liquidity-buffer math.
- **LLM layer (Anthropic Claude):** ingest unstructured RWA signals (attestations, reserve/regulatory/issuer news) → structured risk flags + written rationale + de-risk verdict. See [spec.md §3](./spec.md) for the prompt schema.
- **Guardrail validator:** TS mirror of on-chain guardrails; rejects/repairs any proposal that violates limits **before** signing.
- **Scheduler:** periodic + **event-triggered** (depeg / oracle-staleness / utilization spike).
- **Execution:** signs and submits `rebalance`/`deRisk`; pins rationale + evidence to IPFS; writes outcome to `AgentBenchmark`.
- **x402 micropayments:** pays per-call for premium risk feeds; exposes its own RWA risk score at a 402-gated endpoint.

### 3.5 Frontend (React + Vite + Tailwind + daisyUI)

- **Account dashboard** — balance, blended APY, current allocation (USDY/mUSD / Aave / idle / AUSD), share price, baseline counter.
- **Risk-guardian feed** — each decision with AI rationale **and the evidence that triggered it** (depeg reading, oracle status, headline) — radical transparency.
- **RWA risk radar** — USDY NAV-vs-DEX peg, oracle freshness, AUSD proof-of-reserves, Aave utilization.
- **Agent identity card** — ERC-8004 NFT + verifiable track record.
- **Deposit/withdraw**, testnet/mainnet toggle, conversational "Ask the agent."

---

## 4. Data vs execution boundary

**Separate _data_ (read) from _execution_ (money movement).**

- **Data layer → use 1delta API** for Aave/market data on Mantle (rates, utilization, TVL, risk scores, IRM curves), backstopped by **direct RPC** for assets we hold.
  - `GET /v1/data/lending/pools?chainId=5000`, `/lending/irm`, `Data › Yields`, `Data › Prices`, `Data › User Positions`.
- **Execution layer → our own adapters only. 1delta is NEVER in the custody/execution path.** The vault must not execute arbitrary third-party calldata.
  - **One bounded exception:** the agent may query 1delta for best USDC↔USDY / USDC↔AUSD routing, then pass the route into our adapter, which enforces `minOut` on-chain.

---

## 5. Mantle protocol reality

**Usable RWAs:**

- **USDY (Ondo)** — live. **Blocklist-based** transfer hook (NOT allowlist); post-40-day-lockup tokens transfer permissionlessly and DEXs list USDY without gating buyers, so a non-blocked contract **can buy/hold via DEX without KYC**. Only **mint/redeem** needs `OndoIDRegistry` whitelist (we avoid that path). Yield-bearing; on-chain `RWADynamicOracle`; monthly attestations. DEX depth is thin (~$28M USDY tokenized on Mantle, but executable DEX depth is much less — tokenized TVL ≠ swap depth). We keep USDY/mUSD as the RWA core within a **$50k TVL cap** and lean on the Aave floor + idle buffer. → **Primary RWA (size-aware).**
- **mUSD (Ondo)** — the $1-pegged rebasing form of USDY on Mantle (`0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3`, 18 dec), convertible to/from USDY via the **Ondo Token Converter** (the mUSD contract itself). Same Treasury exposure and risk profile as USDY — a second on-chain form of the RWA core, not a separate bucket.
- **AUSD (Agora)** — live, native on Mantle (`0x00000000efe302beaa2b3e6e1b18d08d69a9012a`, 6 decimals). Reserve-backed (cash + T-bills + repo; VanEck / State Street / PwC), **on-chain proof-of-reserves (Chaos Labs)**. Permissionless to hold. Stablecoin (no native holder yield). → **Safety leg + rich risk-data source.**

**RWAs ruled out:**
- **syrupUSDT/USDC (Maple)** — deposits not supported on Mantle. Out.
- **MI4 (Mantle's fund)** — Reg S, accredited/authorized-participants only, transfers restricted. Out.

**Lending:**
- **Aave v3** — the only deep market on Mantle (~$1.34B; 3rd-largest Aave market globally). → **Our DeFi-yield + liquidity leg.**
- **No RWA collateral markets; no USDY looping.** Leveraged-Treasury angle is out of scope.

**Network:** Mantle mainnet — chain ID **5000** (`0x1388`), RPC `https://rpc.mantle.xyz`, explorer `https://mantlescan.xyz`. EVM-equivalent.

**ERC-8004 registries (confirmed on Mantle):** Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Both present on Mantle — production uses the canonical singletons.

---

## 6. Design decisions

1. **Shape:** AI risk-guardian real-yield account — consumer product.
2. **Deposit asset:** USDC.
3. **Assets:** USDY/mUSD (primary RWA yield core — two on-chain forms, convertible via the Ondo Token Converter) + Aave USDC (DeFi floor + liquidity) + idle USDC buffer + AUSD (safety). DEX depth on Mantle is thin; system operates within a **$50k TVL cap** and keeps an AUSD-primary fallback armed.
4. **Sourcing:** all RWA legs via **DEX** (USDY/AUSD), on-chain `minOut`; no KYC-gated mint in the vault path.
5. **Agent execution:** guardrail-bounded **ALLOCATOR** hot key + kill switch.
6. **LLM:** **Anthropic Claude** via `@anthropic-ai/sdk`. Wrapped behind a thin `LLMClient` interface in `agent/src/llm/` so it stays mockable in tests.
7. **Data:** 1delta API (data + optional swap routing) + direct RPC ground-truth; own adapters for execution.

---

## 7. Scope

### Core features (shipped)

- ERC-4626 `YieldVault` + `UsdyAdapter` (incl. mUSD leg) + `AaveV3Adapter` + `AusdAdapter` + idle buffer + `Guardrails` (depeg/oracle guard)
- `Decision` + `AgentBenchmark` ledger with **agent-vs-passive-USDY baseline**
- AI risk-guardian service: 1delta+RPC ingestion → deterministic risk engine → **LLM rationale (hero path: news/attestation → structured risk signal)** → guardrail validator → on-chain rebalance + event-triggered de-risk
- Anthropic LLM client behind a thin, mockable `LLMClient` interface
- ERC-8004 identity (canonical 0x8004 singletons on Mantle)
- Frontend: account dashboard + risk-guardian feed (rationale + evidence) + deposit/withdraw + identity card + baseline counter
- Deployed on Mantle mainnet (5000) and Sepolia testnet (5003) — see [`deployments/`](../deployments/) and [`packages/shared/src/deployments.ts`](../packages/shared/src/deployments.ts)

### Additional features (shipped)

In priority order:
1. `AusdAdapter` (second safety bucket for de-risk) + AUSD proof-of-reserves signal
2. RWA risk radar viz (USDY peg, oracle freshness, AUSD PoR, Aave utilization)
3. Conversational agent ("why am I in AUSD?", "what changed?") + Telegram/Discord alerts
4. **Agent micropayments (x402) + verifiable jobs (ERC-8183)** — the agent pays per-call for premium risk feeds; exposes its RWA risk signal as an x402-paid endpoint; each de-risk modelled as an ERC-8183 escrowed Job whose evaluator is the deterministic guardrail validator, feeding ERC-8004 reputation.
5. RWA core mUSD leg — `UsdyAdapter` also holds/routes the mUSD form, convertible via Ondo wrap/unwrap.

### Out of scope

RWA looping/leverage (no market on Mantle supports it); cross-chain; KYC'd USDY minting; syrup/MI4 (unavailable/permissioned); production audit.

---

## 8. Known constraints & mitigations

| Constraint | Mitigation |
|---|---|
| USDY DEX liquidity is thin on large orders | $50k TVL cap; absolute USDY notional cap ($5k); serve withdrawals from idle + Aave first. |
| False-positive de-risk | Deterministic thresholds gate the action; AI explains, doesn't decide alone. |
| AUSD is not yield-bearing | AUSD is a safety leg, not the yield core; yield comes from USDY + Aave. |
| USDY blocklist hook may revert vault transfers | Vault address confirmed non-blocked; hook reverts handled gracefully; tests on fork. |
| 1delta outage / rate limits | Data-only dependency; RPC ground-truth fallback for all held assets. |
| AI proposes unsafe allocation | Deterministic validator + timelocked on-chain guardrails + kill switch. |
| Anthropic API down / timeout | LLM is advisory only; on failure the agent falls back to the deterministic allocation. The model is never the last line of defense. |
