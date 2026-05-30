# Sentinel — Project Plan

> An AI risk-guardian real-yield account on Mantle. Users deposit USDC; an AI
> agent earns tokenized-Treasury (USDY) yield while continuously watching
> real-world RWA risk and **autonomously de-risking on-chain** — rotating into a
> DeFi yield floor (Aave) or a reserve-backed safe asset (AUSD) when danger
> appears. Every decision and its triggering evidence are recorded on-chain under
> an ERC-8004 agent identity.

**Status:** Plan locked (v2 — pivoted to real, available Mantle RWAs). No code yet.
**Working name:** _Sentinel_ (placeholder; may rename).

---

## 1. Hackathon context

- **Event:** The Turing Test Hackathon 2026 (Mantle), DoraHacks.
- **Deadline:** **2026-06-15 15:59 UTC.** Target **feature-freeze by 2026-06-12**, leaving 2–3 days for testing, the demo video, and submission/marketing.
- **Primary track:** **AI × RWA** (Exclusively Supported by Mantle Network) — **Path B: [AI-Driven] RWA Application** ("end-user-facing AI × RWA products that lower the barrier to real-asset investing").
- **Also eligible from the same codebase:** Grand Champion, Best UI/UX, Community Voting, and the **20 Project Deployment Award**.
- **The three "defining features" we deliberately lean into:**
  1. **On-chain benchmarking of AI** — every agent decision + outcome recorded on Mantle.
  2. **ERC-8004 agent identity** — the agent is issued an on-chain identity NFT and accrues reputation from its risk-management track record.
  3. **Radical transparency** — human-readable rationale + the triggering evidence for every action, surfaced in the UI.

### Scoring we optimize against
- **AI × RWA General (60%):** depth of AI × RWA integration, technical completeness, Mantle integration, **compliance awareness**.
- **AI × RWA Track-specific (40%, Application):** **Real-World Validity** — clear asset category + well-defined target users + complete user experience.
- **Grand Champion (cross-track):** Technical Depth 30%, Innovation 25%, Mantle Ecosystem Contribution 25%, Product Completeness 20%.

---

## 2. Product

**One-liner:** _Set-and-forget real-yield on tokenized US Treasuries, with an AI that watches the risks a stablecoin holder can't — and defends your money on-chain, verifiably._

**Target user:** Non-US retail seeking safe dollar yield without babysitting RWA risk, and small DAO/treasuries wanting a productive, defensible cash position with an auditable decision trail.

**JTBD:** _"Earn real-asset-backed yield on my dollars, automatically protect me from RWA-specific tail risks (depeg, oracle/issuer/regulatory events), and prove every move was justified."_

**Why it's not "just a USDY wrapper":** the swap-to-USDY is only the resting state. The product is the **autonomous, verifiable management and defense** around it (see §4.2): risk-aware allocation, automatic de-risking, and an on-chain evidence ledger. Remove the AI and the product can't read an attestation or a regulatory headline — the oracle-deviation trigger is deterministic, but the unstructured-signal path isn't.

---

## 3. The honest "AI vs algorithm" split (innovation story)

We do **not** put AI where a deterministic algorithm is better. The AI is the **risk guardian**, not a black box that touches money directly.

**Deterministic / on-chain (algorithmic):** yield & APY math, allocation under constraints, peg/NAV deviation thresholds (oracle vs DEX spot), oracle-staleness check, liquidity-buffer sizing, slippage caps, guardrail enforcement, execution. The deterministic de-risk trigger (USDY DEX price vs oracle NAV deviation) is deliberately algorithmic — it doesn't need the AI.

**AI / LLM — only where it genuinely beats a threshold:**
1. **Unstructured → structured RWA risk signals** ← **the hero path.** Ondo/USDY monthly attestations, AUSD proof-of-reserves status, sanctions/regulatory/issuer headlines, Treasury-rate regime context. A threshold can't read a PDF or a news wire. This is the only path where removing the AI would leave a real gap.
2. **Explainability** — human-readable rationale + cited evidence for every action, recorded on-chain. This is what makes the benchmarking story legible.
3. **Judgment on novel/ambiguous issuer or regulatory events** — always bounded by on-chain guardrails; the AI may only tighten risk, never loosen it.
4. **Conversational UX** (Addendum) — "why am I in AUSD right now?", "what changed today?".

**The demo hero is not the oracle-deviation de-risk — it is an AI reading an attestation or regulatory signal that a pure threshold would miss, then triaging it into a bounded verdict.** Build and demo that path first.

**Safety model:** the LLM **proposes** target weights + a de-risk verdict; a **deterministic validator** checks the proposal against guardrails **before** signing; **immutable on-chain guardrails** are the final backstop. The model is never the last line of defense.

---

## 4. Architecture

### 4.1 Assets & allocation buckets
- **USDY (Ondo)** — RWA yield core (tokenized US Treasuries, ~4.5%, NAV/price-accruing).
- **Aave v3 USDC supply** — DeFi-yield leg **and** instant withdrawal liquidity (deep, redeemable on demand).
- **Idle USDC buffer** — instant small withdrawals.
- **AUSD (Agora)** — flight-to-safety leg (reserve-backed: cash + T-bills + repo; on-chain proof-of-reserves).

### 4.2 The managed-allocation mechanism (the product)
1. User deposits **USDC**, receives ERC-4626 **shares**.
2. The AI sets **target weights** across the buckets from (a) the **yield spread** (USDY Treasury yield vs Aave supply APY, risk-adjusted) and (b) **RWA risk signals**.
3. **Yield reaches users via share-price appreciation** (USDY NAV accrual + Aave interest) — no rebasing, no claim step.
4. **Risk-guardian action:** on a danger signal (USDY DEX price vs `RWADynamicOracle` NAV deviation = depeg, oracle staleness, attestation/regulatory shock), the agent **auto-rotates out of USDY into AUSD/USDC**, or **pauses**, and writes the decision + **evidence hash/URI** on-chain.
5. **Withdrawals** are served from **idle + Aave first** (instant); only large redemptions unwind USDY via DEX. The buffer is sized so normal withdrawals never wait on USDY liquidity.

### 4.3 Smart contracts (Foundry — forge/anvil/cast)
- **`YieldVault`** — ERC-4626, asset = **USDC**. `rebalance(targetWeights, decisionURI, rationaleHash)` is the **AI-powered on-chain function**, callable **only by the ALLOCATOR role**, emitting a `Decision` event. Withdraw queue respects available liquidity.
- **Strategy adapters (trustless, protocol-direct execution):**
  - `UsdyAdapter` — USDC↔USDY via DEX (USDY/USDC, USDY/WMNT have millions in liquidity), on-chain `minOut`, blocklist-aware.
  - `AaveV3Adapter` — supply/withdraw USDC on Aave v3 Mantle.
  - `AusdAdapter` — USDC↔AUSD via DEX (Merchant Moe), on-chain `minOut`.
- **`Guardrails`** (immutable params): max weight per bucket, **min idle/Aave liquidity buffer**, max slippage, token/venue whitelist, max rebalance frequency, per-tx caps, **pause/kill switch**, add-strategy timelock, and a **depeg/oracle-deviation guard** that can force de-risk.
- **`AgentBenchmark`** — logs each decision + the triggering evidence + later the realized outcome (APY, drawdown avoided) → the **on-chain benchmarking** record.
- **ERC-8004 registries** — register the agent in Identity (ERC-721) + Reputation registries. **If the 0x8004 singletons are not on Mantle, deploy them ourselves** (bringing the Trustless Agents standard to Mantle is itself a headline ecosystem contribution). _(Mantle presence: TO VERIFY ON-CHAIN.)_

### 4.4 Backend AI agent (Node.js + TypeScript + Fastify)
- **Data ingestion (read):** 1delta API (Aave/market data; see §5) + **direct RPC** for held-asset ground-truth (Aave position, USDY `RWADynamicOracle` NAV, USDY DEX price, AUSD proof-of-reserves).
- **Deterministic risk engine:** yield-spread calc, peg/NAV deviation, oracle-staleness check, liquidity-buffer math.
- **LLM layer (Anthropic API (Claude)):** ingest unstructured RWA signals (attestations, reserve/regulatory/issuer news) → structured risk flags; propose weights + written rationale + de-risk verdict.
- **Guardrail validator:** rejects/repairs any proposal that violates limits **before** signing.
- **Scheduler:** periodic + **event-triggered** (depeg / oracle-staleness / utilization spike).
- **Execution:** signs and submits `rebalance`; pins rationale + evidence to IPFS; writes outcome to `AgentBenchmark`.

### 4.5 Frontend (React + Vite + Tailwind + daisyUI)
- **Account dashboard** — balance, blended APY, current allocation (USDY / Aave / idle / AUSD), share price.
- **Risk-guardian feed** — the hero: each decision with AI rationale **and the evidence that triggered it** (depeg reading, oracle status, headline) — radical transparency.
- **RWA risk radar** — USDY NAV-vs-DEX peg, oracle freshness, AUSD proof-of-reserves, Aave utilization (absorbs Option B's insight layer).
- **Agent identity card** — ERC-8004 NFT + verifiable track record (yield earned, de-risk events handled).
- **Deposit/withdraw**, testnet/mainnet toggle, conversational "Ask the agent."

---

## 5. Data vs. execution boundary (1delta) — non-negotiable

**Separate _data_ (read) from _execution_ (money movement).**
- **Data layer → use 1delta API** for Aave/market data on Mantle (rates, utilization, TVL, risk scores, IRM curves), backstopped by **direct RPC** for assets we hold.
  - `GET /v1/data/lending/pools?chainId=5000`, `/lending/irm`, `Data › Yields`, `Data › Prices`, `Data › User Positions`. API key from `auth.1delta.io`; cache server-side.
- **Execution layer → our own adapters only. 1delta is NEVER in the custody/execution path.** The vault must not execute arbitrary third-party calldata.
  - **One bounded exception:** the agent may query 1delta `Actions › Swap` for best USDC↔USDY / USDC↔AUSD routing, then pass the route into our adapter, which enforces `minOut` on-chain. A direct router call (Merchant Moe / Agni) with `minOut` is the fallback.

---

## 6. Verified Mantle reality (research, 2026-05 — re-verify on-chain before integrating)

**Usable RWAs:**
- **USDY (Ondo)** — live. **Blocklist-based** transfer hook (NOT allowlist); post-40-day-lockup tokens transfer permissionlessly and DEXs list USDY without gating buyers, so a non-blocked contract **can buy/hold via DEX without KYC**. Only **mint/redeem** needs `OndoIDRegistry` whitelist (we avoid that path). Yield-bearing; on-chain `RWADynamicOracle`; monthly attestations. **Liquidity confirmed: USDY/USDC and USDY/WMNT have millions on Mantle DEXs.** → **Primary RWA.**
- **AUSD (Agora)** — live, native on Mantle (`0x00000000efe302beaa2b3e6e1b18d08d69a9012a`, 6 decimals). Reserve-backed (cash + T-bills + repo; VanEck / State Street / PwC), **on-chain proof-of-reserves (Chaos Labs)**. Permissionless to hold; DEX pairs with USDe/USDT (Merchant Moe). Stablecoin (no native holder yield). → **Safety leg + rich risk-data source.**

**RWAs we ruled out:**
- **syrupUSDT/USDC (Maple)** — deposits **not supported on Mantle** (ETH/Base/Arb/Plasma only) + auth required. Out.
- **MI4 (Mantle's fund)** — Reg S, accredited/authorized-participants only, transfers restricted. Out (permissioned).

**Lending reality (composability is thin):**
- **Aave v3** — the only deep market on Mantle (~$1.34B; 3rd-largest Aave market globally). USDC/USDe/GHO/wETH/FBTC/wrsETH; mETH/cmETH + RWAs on roadmap. → **Our DeFi-yield + liquidity leg.**
- **Compound USDe (Comet)** — second, smaller (base USDe; ETH/FBTC/mETH collateral). Optional later.
- **INIT** disabling new borrows; **Lendle** shutting down; **Dolomite** tiny / 100% utilized. **No RWA collateral markets; no USDY looping.** → leveraged-Treasury angle is **dropped** for this hackathon.

**Network:** Mantle mainnet — chain ID **5000** (`0x1388`), RPC `https://rpc.mantle.xyz`, explorer `https://mantlescan.xyz`. EVM-equivalent.

**ERC-8004 registries (deterministic, cross-chain):** Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (observed elsewhere). **Mantle presence: TO VERIFY; deploy if absent.**

---

## 7. Locked decisions

1. **Track / shape:** AI × RWA, **Application path** — consumer AI risk-guardian real-yield account.
2. **Deposit asset:** USDC.
3. **Assets:** USDY (primary RWA yield) + Aave USDC (DeFi floor + liquidity) + idle USDC buffer + AUSD (safety). _Fallback: AUSD-primary if USDY liquidity degrades — not expected, liquidity confirmed._
4. **Sourcing:** all RWA legs via **DEX** (USDY/AUSD), on-chain `minOut`; no KYC-gated mint in the vault path.
5. **Agent execution:** guardrail-bounded **ALLOCATOR** hot key + kill switch.
6. **LLM:** **Z.ai (GLM-4, primary)** / Anthropic Claude (fallback) — behind a pluggable `LLMClient` interface in `agent/src/llm/`; same JSON contract per SPEC §3 for both. Z.ai is on the judging panel; no bounty confirmed but affinity is a real factor. Swap is a one-file change.
7. **Data:** 1delta API (data + optional swap routing) + direct RPC ground-truth; own adapters for execution.

---

## 8. Scope

### Core (ship this — the submission)

Everything below must be done before any Addendum work begins.

- ERC-4626 `YieldVault` + `UsdyAdapter` + `AaveV3Adapter` + idle buffer + `Guardrails` (depeg/oracle guard)
- `Decision` + `AgentBenchmark` ledger with **agent-vs-passive-USDY baseline** (passive = no rebalancing; compare realized bps vs what a static USDY holder would have done — this is the Turing Test answer)
- AI risk-guardian service: 1delta+RPC ingestion → deterministic risk engine → **LLM rationale (hero path: news/attestation → structured risk signal)** → guardrail validator → on-chain rebalance + event-triggered de-risk
- **Demo-trigger harness**: fork-injectable depeg/oracle-staleness condition that fires the hero de-risk moment on demand for the video
- Pluggable `LLMClient` interface (Z.ai primary / Anthropic fallback)
- ERC-8004 identity (use 0x8004 singletons if on Mantle; else minimal own registry)
- Frontend: account dashboard + **risk-guardian feed** (rationale + evidence) + deposit/withdraw + identity card + **baseline counter** ("passive USDY holder: +X bps / Sentinel: +Y bps, de-risk avoided Z bps drawdown")
- Deployed + **verified on mantlescan**; public frontend (Docker/Caddy)
- **≥2-min demo video** showing: deposit → earning → AI reads attestation/news signal → live de-risk → on-chain decision with evidence → baseline comparison
- README + one-line pitch

### Addendum (tackle if Core is fully done and time remains)

Ordered by hackathon impact:
1. `AusdAdapter` (second safety bucket for de-risk) + AUSD proof-of-reserves signal
2. RWA risk radar viz (USDY peg, oracle freshness, AUSD PoR, Aave utilization)
3. Conversational agent ("why am I in AUSD?", "what changed?")
4. Telegram/Discord alerts on de-risk events
5. Compound USDe leg
6. Per-user EIP-712 signed risk-profile mandates
7. Multi-agent reputation leaderboard

### Won't (this hackathon)

RWA looping/leverage (no market on Mantle); cross-chain; KYC'd USDY minting; syrup/MI4 (unavailable/permissioned); production audit.

---

## 9. Phased milestone plan (freeze ≈ 2026-06-12)

All phases are Core until Phase 5b. Addendum work only starts after Phase 5a exit.

- **Phase 0 — Foundations & gates:** repo + Foundry/Vite/Docker scaffold; Mantle mainnet-fork harness (`anvil --fork`); **verify on-chain**: USDY/AUSD DEX pools + slippage $100–$1k, USDY `RWADynamicOracle`, Aave Pool/DataProvider, 0x8004 presence; **demo-trigger harness** (fork helper to inject depeg/oracle-staleness on demand). _Exit: forked tests read Aave reserves, USDY NAV, USDC↔USDY quote; depeg can be injected cleanly._
- **Phase 1 — Vault core:** ERC-4626 vault + guardrails + `AaveV3Adapter` + idle buffer. _Exit: deposit → Aave → withdraw works on fork._
- **Phase 2 — RWA + risk guard:** `UsdyAdapter` (DEX, `minOut`, blocklist-aware) + depeg/oracle guard + `Decision`/`AgentBenchmark` (including **passive-USDY baseline** tracking). _Exit: USDY↔safe rotation emits on-chain decision with evidence; baseline delta computed._
- **Phase 3 — AI agent:** 1delta+RPC ingestion + deterministic risk engine + **pluggable LLM interface (Z.ai primary / Anthropic fallback)** + **news/attestation → de-risk hero path** + guardrail validator + scheduler. _Exit: autonomous detect→de-risk loop on fork, triggered by an injected attestation/news signal._
- **Phase 4 — ERC-8004 + frontend:** register identity; build dashboard, **risk-guardian feed**, **baseline counter**, identity card, deposit/withdraw. _Exit: clickable end-to-end app on testnet with baseline visible._
- **Phase 5a — Mainnet deploy (Core):** deploy + **verify on mantlescan**, fund small real position, trigger one real de-risk cycle. _Exit: live mainnet loop proven; Deployment-Award bars ticking._
- **Phase 5b — Addendum (time-permitting):** `AusdAdapter` + AUSD PoR signal; risk radar viz; conversational agent; alerts. Work from the Addendum list in priority order; stop when time runs out. _Exit: whatever shipped._
- **Phase 6 — Freeze & polish (≈06-12):** public frontend (Docker/Caddy); README (setup + architecture + addresses); one-line pitch; **≥2-min demo video: deposit → AI reads attestation/news → de-risk fires → on-chain decision → baseline comparison**; X/Twitter assets.
- **Phase 7 — Buffer (06-13/14):** bug-fixing, submission dry-run, re-record if needed.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| "It's just a USDY wrapper" perception | Hero demo = AI reading attestation/news → de-risk; baseline counter shows bps saved vs passive holder. |
| Demo video has no fireable de-risk moment | Demo-trigger harness (Phase 0) lets us inject depeg/oracle-staleness on demand; lock this before any other phase. |
| "The AI is decorative" critique | News/attestation → structured signal is the only hero path; we never claim the oracle-deviation trigger is AI. |
| USDY liquidity on large withdrawals | Serve withdrawals from idle + Aave first; size buffer; only large redemptions touch USDY DEX. |
| Depeg/false-positive de-risk | Deterministic thresholds gate the action; AI explains, doesn't decide alone. |
| AUSD is not yield-bearing | AUSD is a *safety* leg, not the yield core; yield comes from USDY + Aave. |
| USDY blocklist hook reverts vault transfers | Confirm vault address is non-blocked; handle hook reverts gracefully; tests on fork. |
| 1delta outage / rate limits | Data-only dependency; API key + cache; RPC ground-truth fallback for held assets. |
| AI proposes unsafe allocation | Deterministic validator + immutable on-chain guardrails + kill switch. |
| Z.ai API reliability / compatibility | Both Z.ai and Anthropic implement the same `LLMClient` interface; fallback is a one-line env change. |
| Scope creep / not finishing | Core / Addendum split is hard. Addendum doesn't start until Phase 5a exits. Freeze 06-12. |

---

## 11. Submission checklist (20 Project Deployment Award bars)

- [ ] Smart contract deployed on Mantle (mainnet or testnet).
- [ ] Contract **verified on Mantle Explorer**.
- [ ] At least one **AI-powered function callable on-chain** (`rebalance`/de-risk, agent-driven).
- [ ] Frontend demo **publicly accessible** (not localhost).
- [ ] **Deployment address** in the DoraHacks submission.
- [ ] **Demo video ≥ 2 min** (screen capture + voiceover ok) showing the core use case + a de-risk event.
- [ ] Open-source repo with **README** (setup, architecture, deployed addresses).
- [ ] One-line pitch + answers: what RWA / role of AI / how it's realized on Mantle.

---

## 12. Tech stack (fixed)

- **Contracts:** Solidity + Foundry (forge, anvil, cast).
- **Frontend:** React + Vite + Tailwind + daisyUI.
- **Backend/agent/API:** Node.js + TypeScript + Fastify.
- **Testing:** Vitest (TS) + Forge (Solidity).
- **Deploy:** Docker (backend + frontend) behind Caddy (or nginx).
- **LLM:** Z.ai GLM-4 (primary) / Anthropic Claude (fallback) — pluggable interface. **Data:** 1delta API + Mantle RPC.
