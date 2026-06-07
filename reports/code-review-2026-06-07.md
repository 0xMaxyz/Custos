# Code Review — Custos (AI risk-guardian vault on Mantle)

**Reviewer:** senior DeFi engineer pass · **Date:** 2026-06-07 · **Scope:** `contracts/src`, `agent/src`, `packages/shared`, config/deploy/web (sweep)

## Summary

The architecture is sound and the discipline is real: a three-layer control plane (deterministic engine → LLM may only *tighten* → on-chain `Guardrails`), adapters tightly scoped to `onlyVault` with a pinned router and balance-delta `minOut`, ReentrancyGuard + CEI + SafeERC20 throughout, and TS guardrail constants that match `Guardrails.sol` defaults value-for-value. Secrets hygiene and the read-only agent mode are well done.

But the product's headline — *verifiable autonomous de-risk* — is where the defects cluster. Two issues combine to make a de-risk silently ineffective, and the on-chain oracle-staleness backstop is dead code on Mantle. None of these are reachable by an external attacker against user principal directly (caps bound exposure to ~$5k USDY, withdrawals are instant-liquidity gated), but they break the thing the project is selling.

**Verdict: Request Changes.** Fix C1/C2 before any demo that exercises de-risk; address H1–H3 before mainnet.

## Critical

| # | File:Line | Issue |
|---|-----------|-------|
| C1 | `agent/src/executor/index.ts:323` | USDY unit conversion off by 10¹² — de-risk/trim sells ~nothing |
| C2 | `contracts/src/YieldVault.sol:451` | De-risk USDY liquidation runs with `minOut = 0` — no on-chain slippage floor |

### C1 — Executor under-sizes the USDY sell by a factor of 10¹²

```ts
// withdraw path: USDY → USDC
const usdcValue = (deltaWeightBps * snapshot.totalAssetsUsdc) / 10_000n;
// usdyOracleNavUsdc is 18-dec
const usdyIn = (usdcValue * 10n ** 18n) / snapshot.usdyOracleNavUsdc;   // ← wrong
```

`usdcValue` is 6-dec, `nav` is 18-dec, and the target `usdyIn` is 18-dec USDY. The correct factor is `10**30`, not `10**18` — exactly what the on-chain adapter uses in the opposite direction (`UsdyAdapter.deposit`: `expectedUsdy = usdcAmount * 1e30 / nav`). Verified numerically: for $1,000 at NAV 1.00 the formula yields `1e-9 USDY` instead of `1000 USDY`.

Impact depends on path:
- **`deRisk()` path** — the dust quote sells ~0 USDY; `emergencyWithdrawAll` (see C2) has no floor, so the tx *succeeds* and emits `DeRisked` while the USDY position remains. The core safety action silently no-ops. (If the aggregator rejects the dust quote, `swapData[2]` is empty → `EmptySwapData` revert → de-risk fails loudly instead. Either way it's broken.)
- **rebalance-down path** — `adapter.withdraw(delta, 0, …)` self-enforces `minOut = delta`, so the undersized swap reverts. The agent cannot trim USDY via rebalance.

**Fix:** use `10n ** 30n`. Add a regression test at the executor→chain seam (the fork tests appear to construct `swapData` independently, which is why this slipped through).

### C2 — De-risk liquidation bypasses the balance-delta guard

```solidity
// YieldVault._unwindUsdyToAusd
usdyAdapter.emergencyWithdrawAll(0, address(this), sd);   // minOut hardcoded 0
```

`UsdyAdapter.emergencyWithdrawAll` forwards `minOutUsdc` straight into `AggregatorSwapLib.swap`, so `minOut = 0` means `received < 0` is never true — **zero on-chain slippage protection on the single most value-sensitive operation.** The entire custody model rests on "never trust the router's `minOut`; enforce a balance-delta floor instead" — and the de-risk path opts out of exactly that. On Mantle's ~$1.5k USDY pools, liquidating up to the $5k cap through a route with no on-chain floor is a real MEV/slippage hole.

By contrast `emergencyExit` (guardian/kill path) correctly takes a caller-supplied `minOutUsdc`. The de-risk path should too.

**Fix:** derive an oracle-based floor in the vault (e.g. `usdyValue * (1 − maxSlippage)` from `oracleData()`/`totalAssets()` before the call) and pass it as `minOut`, rather than `0`. Accept a partial/looser floor if you must guarantee the exit completes during a depeg, but `0` is indefensible for the product's flagship action.

## High

| # | File:Line | Issue |
|---|-----------|-------|
| H1 | `Guardrails.sol:246` / `YieldVault.sol:530` | On-chain oracle-staleness guards are dead code on Mantle |
| H2 | `YieldVault.sol:536` | Depeg guard's DEX spot is supplied by the ALLOCATOR key it constrains |
| H3 | `YieldVault.sol:259` / `Guardrails.sol:121` | `setGuardrails` / `setConfig` have no timelock |

**H1 — Oracle staleness backstop is non-functional in production.** `Guardrails._evaluateUsdyRisk` has two staleness checks: `oracleStale` (via `oracleRangeEnd`) and `oracleAged` (via `oracleUpdatedAt`). On Mantle: (a) `oracleUpdatedAt` is *never written* — `_buildMarketState` only sets `usdyOracleNav` and `oracleRangeEnd`, and `IUsdyAdapter.oracleData()` returns only `(nav, rangeEnd)`; so `oracleAged` is permanently `false`. (b) Per the adapter's own comments, Mantle's Ondo oracle lacks `currentRange()`, so `oracleData()` returns `rangeEnd = 0`, disabling `oracleStale` too. Net: the on-chain "stale oracle → force de-risk" backstop — the *final* line of defense — does nothing on Mantle. The off-chain engine checks `oracleUpdatedAt`, but the on-chain guardrail is supposed to be the one that can't be bypassed. Either feed `updatedAt` (e.g. from oracle round data) into `MarketState`, or document that the adapter's `_requireOracleFresh`/`getPrice` revert is the only real staleness guard and design accordingly.

**H2 — Self-reported peg input.** `_buildMarketState` sets `s.usdyDexSpot = usdyDexSpotUsdc`, the value the ALLOCATOR passes into `rebalance`/`deRisk`. The depeg guard that's meant to block *new* USDY allocation during a depeg is therefore fed by the same hot key it constrains. A compromised or buggy allocator can pass `spot == nav` to zero the deviation and clear `UsdyAllocationBlocked`. There's no on-chain cross-check (no DEX TWAP). Exposure is bounded by the $5k notional and 60% weight caps, but this materially weakens the "immutable on-chain guardrail" claim on the entry path. Consider an on-chain spot read (even a thin-pool TWAP as a sanity band) or, at minimum, document this as a trusted input.

**H3 — Guardrail brain is the least-protected surface.** Adding a strategy is timelocked 48h, but `setGuardrails` (swap to a permissive/always-`ok` Guardrails) and `setConfig` (raise USDY cap to 100%, disable the notional cap) are instant, ADMIN-only. For a project whose thesis is "guardrails are final," the guardrail contract/config should be the *most* timelocked surface. Put `setGuardrails` and config-loosening behind the same (or longer) timelock; config-*tightening* can stay instant.

## Medium / Low

| # | File:Line | Sev | Issue |
|---|-----------|-----|-------|
| M1 | `YieldVault.sol:253` | Med | `removeStrategy` gates on `totalAssets()==0`, but `UsdyAdapter.totalAssets()` returns 0 when the oracle reverts even with USDY held → admin could remove the USDY adapter during an oracle outage and orphan funds. |
| M2 | `executor/index.ts:131` | Med | LLM-only ("news") de-risk routes through `rebalance()`, which is subject to `MAX_REBALANCE_MOVE_BPS` (50%). When USDY weight > 50% (possible at low TVL where the $5k notional cap exceeds 50% of TVL), the full USDY→0 exit hits `MOVE_EXCEEDS_MAX` (UNFIXABLE) and silently no-ops. Only the deterministic `forceDeRisk` path (move-cap exempt) works for large positions. |
| M3 | `AaveV3Adapter.sol:78` | Low–Med | `maxWithdrawable` uses `USDC.balanceOf(aUSDC)` as the liquidity proxy; ignores reserve pause/caps and can over-report. |
| L1 | `UsdyAdapter.sol:208` | Low | `maxWithdrawable()` does an external `this.totalAssets()` self-call; use an internal helper. |
| L2 | `executor/ipfs.ts` | Low | IPFS pin has no timeout; a slow pinning provider blocks the cycle (the pin is otherwise fail-open). |
| L3 | `executor/index.ts:383` | Low | `extractDecisionId` calls `BigInt(topics[1])` without validating hex shape. |
| L4 | `data/oneDelta.ts:148` | Low | API error omits the response body, hurting debuggability. |
| L5 | `server.ts:92` | Low | `Access-Control-Allow-Origin: *` on all routes — acceptable today (read-only + x402), but revisit before adding any authenticated/mutating endpoint. |
| L6 | `llm/signals.ts:71` | Low | `Number(bigint)/1e18` formatting loses precision above 2⁵³; safe under the $50k TVL cap, not generally. |

## What looks good

The validator is genuinely sound: `clampVerdict` (signals.ts) re-parses the LLM output, clamps USDY to the deterministic ceiling, requires cited evidence for `deRisk`, and only escalates risk level; `applyVerdict` clamps to `min(verdict, ceiling, candidate)`; the `UNFIXABLE` set prevents auto-repair from masking interval/move/peg violations. The LLM cannot loosen anything. Constants are imported from `@custos/shared` and match Solidity exactly. Adapters are minimal and well-bounded (pinned immutable router, single max-allowance, balance-delta `minOut` on entry and normal exit, `onlyVault`). Quote handling is fail-closed (empty `swapData` → revert). The agent runs read-only without a key, config is zod-validated, `.env` is gitignored, and no secrets are logged. `CustosJobEscrow` follows CEI + `nonReentrant` cleanly.

## Recommended order

1. C1 (`10**30`) + C2 (oracle-derived `minOut` on de-risk) — together they're a fail-*open* break of the headline feature. Add an executor→chain de-risk regression test.
2. H1 staleness feed, H3 guardrail timelock, H2 spot-input hardening/doc.
3. M1/M2 edge cases, then the Low cleanup.
