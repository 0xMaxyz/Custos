# Sentinel — Project Plan

> Autonomous, risk-managed RWA yield vault on Mantle. An AI agent allocates
> stablecoins across tokenized US Treasuries (USDY) and Mantle lending markets
> (Aave v3, INIT), rebalancing within hard on-chain guardrails and recording
> every decision + outcome on-chain under an ERC-8004 agent identity.

**Status:** Plan locked. No code written yet.
**Working name:** _Sentinel_ (placeholder; may rename).

---

## 1. Hackathon context

- **Event:** The Turing Test Hackathon 2026 (Mantle), DoraHacks.
- **Deadline:** **2026-06-15 15:59 UTC.** Target **feature-freeze by 2026-06-12**, leaving 2–3 days for testing, the demo video, and submission/marketing.
- **Primary track:** **AI × RWA** (Exclusively Supported by Mantle Network).
- **Also eligible from the same codebase:** Grand Champion, Best UI/UX, Community Voting, and the **20 Project Deployment Award**.
- **The three "defining features" we deliberately lean into:**
  1. **On-chain benchmarking of AI** — every agent decision + outcome recorded on Mantle.
  2. **ERC-8004 agent identity** — the agent is issued an on-chain identity NFT and accrues reputation.
  3. **Radical transparency** — human-readable rationale for every action, surfaced in the UI.

### Scoring weights we are optimizing against (AI × RWA, General 60% + Track-specific 40%)
- AI × RWA integration depth, technical completeness, Mantle integration, **compliance awareness**.
- Grand Champion rubric (for cross-track eligibility): Technical Depth 30%, Innovation 25%, Mantle Ecosystem Contribution 25%, Product Completeness 20%.

---

## 2. Product

**One-liner:** _An autonomous, risk-managed RWA yield vault on Mantle that earns real-asset-backed yield and proves — on-chain — why every move was made._

**User / JTBD:** A DeFi-literate-but-busy holder or a small DAO/treasury that wants stable, real-asset-backed yield without babysitting utilization/peg risk across protocols, and without trusting an opaque black box. _"Earn the best risk-adjusted yield on my dollars using real assets, and show me exactly why every move was made — verifiably."_

---

## 3. The honest "AI vs algorithm" split (our innovation story)

We deliberately do **not** put AI where a deterministic algorithm is better. This is a core design value and a scoring advantage (real Innovation, not AI-washing).

**Deterministic / on-chain (algorithmic):**
- Yield & APY math, allocation optimization under constraints.
- Utilization / liquidity tracking, peg-deviation thresholds.
- Slippage caps, guardrail enforcement, execution.

**AI / LLM (Z.AI) — only where it genuinely wins:**
1. **Unstructured → structured risk signals** — parse Aave/INIT governance posts, incident/exploit news, Ondo/USDY disclosures, and social sentiment into structured risk flags.
2. **Explainability** — a human-readable rationale for every rebalance (the "radical transparency" feature).
3. **Judgment on novel/ambiguous events** — depegs, exploits, governance attacks — always bounded by on-chain guardrails.
4. **Conversational UX** — "explain my risk," "what changed today."

**Safety model:** the LLM **proposes**; a deterministic validator checks the proposal against guardrails **before** anything is signed; on-chain guardrails are the final, immutable backstop. Safety is never the model alone.

---

## 4. Architecture

### 4.1 Smart contracts (Foundry — forge/anvil/cast)
- **`YieldVault`** — ERC-4626, asset = **USDC**. Holds an idle buffer + positions via adapters. `rebalance(targetWeights, decisionURI, rationaleHash)` is the **AI-powered on-chain function**, callable **only by the ALLOCATOR role**, emitting a `Decision` event. Withdrawals: idle → unwind strategies in queue order, **respecting available (non-borrowed) liquidity** (see §6 — the Morpho misconception).
- **Strategy adapters** (execution is trustless, protocol-direct):
  - `AaveV3Adapter` — supply/withdraw USDC on Aave v3 Mantle.
  - `UsdyAdapter` — USDC↔USDY via DEX, **blocklist-aware**, on-chain `minOut`.
  - `InitAdapter` — _Should-have_ third strategy.
- **`Guardrails`** (immutable params): max weight per strategy, min idle buffer, max slippage, strategy/token whitelist, max rebalance frequency, per-tx caps, **pause/kill switch**, timelock for adding strategies.
- **`AgentBenchmark`** — logs each decision + later writes realized outcome (APY vs benchmark) → the **on-chain benchmarking** record.
- **ERC-8004 registries** — register the agent in the Identity (ERC-721) + Reputation registries. **If the 0x8004 singletons are not deployed on Mantle, we deploy them ourselves** — bringing the Trustless Agents standard to Mantle is itself a headline ecosystem contribution and matches the organizers' stated narrative. _(Registry presence on Mantle: TO VERIFY ON-CHAIN.)_

### 4.2 Backend AI agent (Node.js + TypeScript + Fastify)
- **Data ingestion (read):** 1delta API (primary; see §5) + direct RPC ground-truth for held assets.
- **Deterministic risk engine:** risk scores, liquidity-stress, peg deviation, risk-adjusted yield; IRM-curve simulation ("if I withdraw X, utilization → Y, rate → Z").
- **LLM layer (Z.AI):** unstructured-signal ingestion → structured flags; proposed allocation + written rationale.
- **Guardrail validator:** rejects/repairs any proposal that violates on-chain limits **before** signing.
- **Scheduler:** periodic + event-triggered (peg break / utilization spike).
- **Execution:** signs and submits `rebalance`; pins rationale to IPFS; writes outcome to `AgentBenchmark`.

### 4.3 Frontend (React + Vite + Tailwind + daisyUI)
- **Vault dashboard** — TVL, live allocation, APY, your position.
- **Agent decision feed** — AI rationale per decision (the "wow" + transparency).
- **Risk radar** — Mantle lending-market health (utilization / liquidity / peg / risk score) across lenders — the data-edge visualization (Insight Value).
- **Agent identity card** — ERC-8004 NFT + verifiable track record (realized APY vs benchmark).
- **Deposit/withdraw**, testnet/mainnet toggle, conversational "Ask the agent."

---

## 5. Data vs. execution boundary (1delta) — non-negotiable

**Principle: separate _data_ (read) from _execution_ (money movement); they have different trust profiles.**

- **Data layer → use 1delta API heavily.** Endpoints we rely on:
  - `GET /v1/data/lending/pools?chainId=5000` — per-pool deposit rate, utilization, TVL, liquidity, **risk score (1–5)** across all 21 Mantle lenders → the risk radar.
  - `GET /v1/data/lending/irm?marketUids=…` — **IRM rate curves** → rate-impact simulation.
  - `Data › User Positions` — health factors / positions.
  - `Data › Yields`, `Data › Prices`, `Data › Vaults` (ERC-4626 across Morpho/Silo/Euler) → benchmarking context.
  - Get an API key (`auth.1delta.io`) to lift the 10-req/15-min limit; **cache server-side**.
- **Execution layer → our own adapters only. 1delta is NEVER in the custody/execution path.** The vault must not execute arbitrary third-party calldata (security + availability + judging reasons).
  - **One bounded exception:** the off-chain agent may query 1delta `Actions › Swap` for the best USDC↔USDY route, then pass it into `UsdyAdapter`, which enforces `minOut` on-chain. A direct router call (Agni/Merchant Moe) with `minOut` is the simple fallback.
- **Ground-truth reads:** for assets we actually hold (Aave position, USDY), also read **directly via RPC** (Aave `DataProvider`, USDY `RWADynamicOracle`) so vault accounting is trustless and a 1delta outage degrades the _radar_, not the _vault_.

---

## 6. Verified Mantle infrastructure (as of research, 2026-05)

> Addresses below are from research and **must be re-verified on-chain before integration** (mark in code as such).

- **Network:** Mantle mainnet — chain ID **5000** (`0x1388`), RPC `https://rpc.mantle.xyz`, explorer `https://mantlescan.xyz` / `https://explorer.mantle.xyz`. EVM-equivalent.
- **Aave v3 on Mantle** — live, ~$1.34B market size (3rd-largest Aave market globally). Assets incl. USDC, USDe, GHO, wETH, FBTC, wrsETH; mETH/cmETH + RWAs on roadmap. **Primary lending integration.**
- **USDY (Ondo)** — live on Mantle. Tokenized US Treasuries, ~4–4.5% APY. Accumulating `USDY` (price-appreciating) + rebasing `rUSDY/mUSD`. On-chain `USDY_InstantManager` (USDC↔USDY, KYC-gated) and `RWADynamicOracle` (price). **Compliance: blocklist + non-US KYC at mint/redeem → we source via DEX, blocklist-aware.** Our RWA leg.
- **INIT Capital** — live. Pools incl. `POOL_METH` `0x5071c003bB45e49110a905c1915EbdD2383A89dF`, `POOL_USDC` `0x00A55649E597d463fD212fBE48a3B40f0E227d06`, `POOL_USDT` `0xadA66a8722B5cdfe3bC504007A5d793e7100ad09`, plus USDe pool. Secondary lending venue.
- **mETH / cmETH** — native Mantle LST; yield + collateral (future leg).
- **ERC-8004 registries (deterministic, cross-chain):** Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (observed on other chains). **Presence on Mantle: TO VERIFY; deploy if absent.**

---

## 7. Locked decisions

1. **Deposit asset:** USDC.
2. **USDY sourcing:** DEX (blocklist-aware, on-chain `minOut`).
3. **Agent execution:** a hot ALLOCATOR key, bounded by on-chain guardrails + kill switch.
4. **LLM provider:** Z.AI (a hackathon partner).
5. **Data:** 1delta API for data + optional swap routing; direct RPC for held-asset ground-truth; our own adapters for execution.

---

## 8. Scope (MoSCoW)

**Must (core demo):** own ERC-4626 vault + `AaveV3Adapter` + `UsdyAdapter` + idle buffer + guardrails + `Decision` log; AI allocator service (Aave + USDY data via 1delta + RPC, risk engine, Z.AI rationale, validator, on-chain rebalance); ERC-8004 identity + benchmark writes; frontend dashboard + decision feed + deposit/withdraw + identity card; deployed + **verified on mantlescan**; public frontend; ≥2-min demo video; README; one-line pitch.

**Should:** `InitAdapter` (3rd strategy); risk-radar viz; conversational agent; event-triggered rebalances; Telegram/Discord alerts.

**Could:** per-user EIP-712 signed mandates (intent pattern); mETH leg; historical backtest/simulation (agent vs benchmark); multi-agent reputation leaderboard.

**Won't (this hackathon):** cross-chain; direct KYC'd USDY minting; production audit; full intent-solver infra.

---

## 9. Phased milestone plan (freeze ≈ 2026-06-12)

- **Phase 0 — Foundations:** repo + Foundry/Vite/Docker scaffold; Mantle mainnet-fork harness (`anvil --fork`); pin + verify live addresses; confirm 0x8004 presence on Mantle. _Exit: forked tests read Aave reserves + USDY price._
- **Phase 1 — Vault core:** ERC-4626 vault + guardrails + `AaveV3Adapter` + idle buffer; full Forge/Vitest tests on fork. _Exit: deposit → allocate to Aave → withdraw works on fork._
- **Phase 2 — RWA + decisions:** `UsdyAdapter` (DEX, blocklist-aware) + `Decision`/`AgentBenchmark` logging + ALLOCATOR role. _Exit: a USDY/Aave rebalance emits a verifiable on-chain decision._
- **Phase 3 — AI agent:** 1delta + RPC ingestion + deterministic risk engine + Z.AI rationale + validator + scheduler; agent executes a real rebalance on fork. _Exit: end-to-end autonomous loop on fork._
- **Phase 4 — ERC-8004 + frontend:** deploy/register identity + reputation; dashboard, decision feed, identity card, deposit/withdraw. _Exit: clickable end-to-end app on testnet._
- **Phase 5 — Mainnet + Should-haves:** deploy + **verify on mantlescan**, fund a small real position; add `InitAdapter` + risk radar + conversational agent. _Exit: live mainnet demo._
- **Phase 6 — Freeze & polish (≈06-12):** public frontend (Docker/Caddy), README (setup + architecture + deployed addresses), one-line pitch, **≥2-min demo video**, X/Twitter assets for Community Voting.
- **Phase 7 — Buffer (06-13/14):** bug-fixing, submission dry-run, re-record video if needed.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Withdrawal liquidity crunch (high underlying utilization) | Idle buffer + utilization-aware AI de-allocation + withdraw queue + on-chain caps. |
| USDY compliance (blocklist/KYC) | Source via DEX, blocklist-aware checks; document compliance posture (scored). |
| 1delta outage / rate limits | Data-only dependency; API key + server-side cache; RPC ground-truth fallback for held assets. |
| AI proposes unsafe allocation | Deterministic validator + immutable on-chain guardrails + kill switch. |
| Hot ALLOCATOR key compromise | Guardrail-bounded role (cannot exceed caps/whitelist); pausable; small mainnet funds. |
| Live-protocol integration edge cases | Develop/test on `anvil --fork` against real mainnet contracts before deploying. |
| Scope creep | MoSCoW discipline; freeze by 06-12; Should/Could only after Must is green. |

---

## 11. Submission checklist (20 Project Deployment Award bars)

- [ ] Smart contract deployed on Mantle (mainnet or testnet).
- [ ] Contract **verified on Mantle Explorer**.
- [ ] At least one **AI-powered function callable on-chain** (`rebalance` driven by the agent).
- [ ] Frontend demo **publicly accessible** (not localhost).
- [ ] **Deployment address** included in the DoraHacks submission.
- [ ] **Demo video ≥ 2 min** walking through the core use case (screen capture + voiceover is sufficient).
- [ ] Open-source GitHub repo with **README** (setup, architecture, deployed addresses).
- [ ] One-line pitch + answers to: data sources used / role of AI / how it's realized on Mantle.

---

## 12. Tech stack (fixed)

- **Contracts:** Solidity + Foundry (forge, anvil, cast).
- **Frontend:** React + Vite + Tailwind + daisyUI.
- **Backend (agent/API):** Node.js + TypeScript + Fastify.
- **Testing:** Vitest (TS) + Forge (Solidity).
- **Deploy:** Docker (backend + frontend) behind Caddy (or nginx) for routing.
- **LLM:** Z.AI.
- **Data:** 1delta API + Mantle RPC.
