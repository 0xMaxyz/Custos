# Project Review (Pass 4) — Custos

**Date:** 2026-06-10 · **Against:** HEAD `908912c` · **Scope:** full project — contracts, agent, web, infra, docs, deploy scripts — plus hackathon-competitiveness and the v1 timelock question. Passes 1–3 (`reports/code-review-2026-06-0*.md`) are assumed read; nothing from them is re-reported. All findings below are net-new and verified against code on disk.

## Summary

The core invariants hold: custody boundary (pinned router, balance-delta `minOut`, `onlyVault`), tighten-only LLM with exact `@custos/shared` ↔ `Guardrails.sol` constant parity (verified value-for-value, zero drift), fail-closed quote handling, and a clean read-only server surface. Prior passes fixed the de-risk-path bugs. What this pass found clusters in three places the earlier passes didn't look: **governance rooting and the new timelock's self-referential delay**, **off-chain operational readiness (tx lifecycle, concurrency, crash recovery, failure alerting)**, and **docs that promise things the implementation no longer (or never) does**.

**Verdict: do not deploy to mainnet yet.** Fix the 5 criticals/highs below first; they're all small. The contracts' logic is sound — the gaps are wiring, ops, and claims.

---

## Criticals / Highs (fix before mainnet)

### H4 — Root admin never leaves the deployer hot key
`script/Deploy.s.sol` grants `DEFAULT_ADMIN_ROLE` + `ADMIN` on `Guardrails`, `YieldVault`, `AgentBenchmark` to `deployer` and never transfers or renounces. The entire H3 timelock work is rooted in one EOA: compromise it and the attacker queues a permissive config, waits 48h, and owns the vault — and since `DEFAULT_ADMIN_ROLE` administers every role, it can grant itself ALLOCATOR/GUARDIAN immediately. `docs/spec.md` §1.5 says ADMIN is "multisig in prod"; the script doesn't implement that.
**Fix:** require an `ADMIN_MULTISIG` env var for chainid 5000 runs; grant roles to it and renounce from the deployer; assert `admin != deployer` in the script.

### O1 — A *failed* de-risk is silent; alerts fire only on success
`agent/src/index.ts` wires `alertNotifier.notify` only inside `onCycle` when `r.submitted === true`. Any throw in `runCycle()` after `forceDeRisk` is detected (tx revert, RPC drop, gas estimation failure, IPFS pin throw) lands in `onError` → `app.log.error`. A depeg during an RPC brownout = repeated silent failures of the flagship action. Inverted from what an operator needs.
**Fix:** executor distinguishes "de-risk required" from "tx confirmed"; fire an alert whenever a required de-risk did not confirm.

### O2 — No tx lifecycle management
`executor/index.ts` calls `waitForTransactionReceipt({ hash })` with no timeout, no fee-bump/replacement, no nonce discipline (`chain/clients.ts` uses viem defaults). A stuck underpriced de-risk tx blocks its scheduler loop indefinitely — breach detection stalls behind it.
**Fix:** `timeout` (~2 min) + `retryCount` on the receipt wait; on timeout, fee-bumped replacement at the same nonce or surface failure into O1's alert path.

### O3 — Periodic loop and breach-poll loop can run `runCycle()` concurrently
`scheduler.ts`: each loop is self-serial but they share no mutex; `injectBreachCondition()` deliberately fires a poll mid-interval. Two concurrent cycles fetch the same pending nonce → one tx replaces the other, or two land. `MIN_REBALANCE_INTERVAL` does **not** backstop this for de-risk (interval-exempt).
**Fix:** single in-flight guard/promise so only one cycle executes at a time.

### M4 — Allocator cannot de-risk during an oracle outage
`YieldVault.deRisk` (allocator path) requires `guardrails.evaluateUsdyRisk(s).forceDeRisk == true`. `_buildMarketState` catches an `oracleData()` revert and leaves `usdyOracleNav = 0`; the peg branch in `Guardrails` requires `nav > 0`, and the staleness branches are inert on Mantle (documented H1). So with a dead oracle — exactly the RWA-danger scenario the product sells — `deRisk` reverts `DeRiskConditionNotMet`; only a human GUARDIAN can act. Pass 1 accepted H1's inertness but missed that it also *disables the autonomous defense*.
**Fix:** treat an `oracleData()` revert as a force-de-risk trigger for the allocator path (sentinel in `MarketState`, or an explicit oracle-down branch in `Guardrails`).

---

## Mediums

### M5 — Timelock delay can ratchet itself to zero; no cancel for a queued config
`Guardrails.queueConfig` reads the delay from the **live** config's `addStrategyTimelock`, and `_requireValidConfig` imposes no floor. One timelocked step (queue a config with `addStrategyTimelock = 0`) collapses all future config/guardrails changes to instant. Separately there is no `cancelConfig()` — a queued config can only be overwritten (timer resets) or activated. (`queueGuardrails(address(0))` happens to work as a cancel on the vault side; config has no equivalent.)
**Fix:** hard floor in `_requireValidConfig` (e.g. `>= 1 days` as a `MIN_TIMELOCK` constant, mirrored in `@custos/shared`), plus `cancelConfig()` (ADMIN). See also the timelock recommendation below.

### O4 — Everything off-chain is in-memory; no idempotency across restart
No persisted state anywhere: `recentDecisions`, the x402 replay NonceStore (pass-3 N3 fix resets on every restart), rate-limiter, caches. A crash between `writeContract` and receipt parse → on restart the agent may re-issue the same tx (chain reads still show old weights while the first tx is pending).
**Fix:** persist last-submitted tx hash + intended post-state; reconcile pending txs on startup before the first cycle. Document x402 replay protection as process-lifetime-only or persist nonces.

### O5 — The agent never actually de-risks *into AUSD*
`executor/index.ts:255` always passes `toBucket = 0` (IDLE) to `deRisk`, and `_buildSwapData` only ever populates `swapData[2]` (USDY leg); `swapData[3]` is never built, so `_unwindUsdyToAusd`'s AUSD leg is dead code in the autonomous loop. USDC-idle is a safe state, so no fund risk — but the headline ("de-risks into AUSD/USDC"), `docs/architecture.md` §3.2, and the demo script all say AUSD. Either wire `BUCKET_AUSD` + the USDC→AUSD calldata, or change the claim everywhere. **For the demo this is the most embarrassing gap** — a judge reading the decision feed will see funds land in IDLE while the narration says AUSD.

### O6 — No startup chain-id assertion
`chain/clients.ts` hardcodes chain 5000 but never verifies the RPC serves it. Mainnet-vs-fork mixups will sign real-money txs against the wrong network silently. `forkBlockNumber` is config-validated but never read at runtime (dead, implies a check that doesn't exist).
**Fix:** assert `getChainId() === 5000` on startup, fail fast; wire or drop `forkBlockNumber`.

---

## Lows / Info

- **L7** — Adapter withdraw paths bound USDC *received* but never cap USDY/mUSD *sold*; allocator-supplied `swapData` can over-liquidate a bucket (proceeds stay in vault, weights diverge from target with no post-check). Consider a max-input bound or post-weight assertion.
- **L8** — `AgentBenchmark.updateOutcome` "already set" guard trusts caller-supplied `measuredAt`; writing `measuredAt = 0` leaves the "immutable" outcome overwritable. Stamp `block.timestamp` in-contract.
- **O7** — Paid `/risk-score` serves up-to-10s-stale cached data with no freshness bound — during exactly the event it's sold to detect. Bypass cache or 503 on stale for the paid path.
- **I1** — No `_decimalsOffset()` override on the ERC-4626 vault (OZ default virtual offset only). $10k/tx + $50k TVL caps bound the inflation-grief blast radius, but a 3–6 offset makes it pointless. Cheap insurance.
- **I2** — `deRisk` builds the market state twice and `totalAssets()` three times per call. Gas only.

## Docs drift (fix wording before judging)

1. **"Immutable guardrails" is no longer true** — `architecture.md` (×3), `agents.md` §2, `marketing.md` (×2) all say "immutable limits/params". Since commit `96fbf7c` they are *timelocked*, not immutable. Judges who read the code will notice. Reword to "timelocked on-chain guardrails (48h)" — arguably a *stronger* claim, since immutable params couldn't have fixed a mis-set threshold.
2. **"De-risks into AUSD/USDC"** — see O5; today it's USDC-idle only. Align code or claims.
3. `architecture.md` §7 still says "mainnet deploy pending keys" — fine, but update alongside the H4 fix (multisig requirement) so the deploy runbook is accurate.

## Hackathon competitiveness (AI × RWA application track)

**Real strengths to lean on:** the three-layer control plane is the differentiator — most competitor "AI DeFi agents" are an LLM with a private key; you can *prove* yours can't loosen risk (tighten-only clamp, constant parity, timelocked guardrails). The on-chain evidence ledger + ERC-8004 identity + benchmark-vs-passive-USDY is exactly the "verifiable" story judges can check live on Mantlescan. The honest AI/algorithm split (deterministic peg trigger, LLM only for unstructured signals) reads as anti-AI-washing — say that out loud in the demo.

**What would cost you points:** (a) the O5 AUSD mismatch mid-demo; (b) a silent failed de-risk during the live hero moment (O1–O3) — the demo's §4 trigger path (`injectBreachCondition`) is precisely the concurrent-poll path O3 affects, so fix O3 before recording; (c) "immutable" wording vs. code for any judge who reads `Guardrails.sol`. The benchmark "drawdown avoided vs passive USDY holder" number is your single best judge-facing metric — make sure the UI surfaces it prominently in the hero shot.

**Worth the hour if you have it:** make `ConfigQueued`/`GuardrailsQueued` events fire an alert (closes the loop on M5/H4 — "even governance changes are watched") and show the agent card + a real Mantlescan decision tx in the demo. Cheap, and it's the kind of end-to-end verifiability competitors won't have.

## Timelock strategy for v1 mainnet (requested)

Of your two options — admin-configurable timelocks vs. deploy-short-then-raise — **deploy-short-then-raise is the right call, and "admin-configurable" is already true today and is exactly the M5 vulnerability.** `addStrategyTimelock` is part of the config and changeable via `queueConfig`, with no floor — so making timelocks "configurable by the admin" adds nothing and, without a floor, lets the delay ratchet to zero. Don't pursue that direction.

Recommended v1:

1. Deploy with a **short initial delay** — e.g. `addStrategyTimelock = 1–6 hours` — passed at deploy time (constructor arg or bootstrap `setConfig`), not the hardcoded `2 days`. With the $50k TVL cap and $10k/tx cap, the blast radius during shakeout is bounded; operational agility matters more in week one.
2. Add the **hard minimum floor** (`MIN_TIMELOCK`, e.g. 1 hour, in `_requireValidConfig` + `@custos/shared`) and **`cancelConfig()`** before deploying — these close M5 regardless of which delay you pick.
3. After mainnet smoke tests pass, `queueConfig` the delay up to **48h**. Note the ratchet works in your favor here: raising the delay only waits the *current* (short) delay, so the upgrade path is fast.
4. The honest caveat: a short timelock weakens the key-compromise story, and the timelock is currently rooted in a single EOA (H4). The short-delay window is only acceptable **if H4 is fixed first** (multisig admin) and queue events are alerted. Short timelock + multisig + alerts > long timelock + hot EOA.

## Verified-fine highlights

Custody boundary (pinned router, self-measured balance delta, output-to-adapter, fail-closed empty calldata, `onlyVault` + `nonReentrant` everywhere, mUSD wrap/unwrap value-neutral with oracle floor). Withdrawals carry no pause/kill gates — users can always initiate, served idle+Aave first; kill-state large redeems revert (not strand) until guardian exit. `@custos/shared` ↔ `Guardrails.sol` parity exact, value-for-value, post-timelock-commit. LLM boundary fail-closed: API failure → deterministic fallback; zod + `clampVerdict` re-clamping; evidence-source allowlist; injected text cannot exceed clamp bounds. Server surface read-only, rate-limited, no secret leakage.

## Recommended order

1. **H4** (multisig + renounce in deploy script) — gates everything else.
2. **M5** (timelock floor + cancel) together with the v1 timelock parameter decision above.
3. **O1 + O2 + O3** (failure alert, tx timeout/replacement, cycle mutex) — one focused agent PR.
4. **M4** (oracle-down → allow allocator de-risk) — small Guardrails/vault change + fork test.
5. **O5** (AUSD leg or claim fix) + docs "immutable→timelocked" sweep — before recording the demo.
6. **O4, O6** (persistence/reconcile, chain-id assert), then L7/L8/O7/I1 as follow-ups.
