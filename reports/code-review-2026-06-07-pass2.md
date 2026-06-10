# Code Review (Pass 2) — Custos

**Reviewer:** senior DeFi full-stack pass · **Date:** 2026-06-07 · **Against:** HEAD `2f1ead1` · **Scope:** re-verify pass-1 fixes + deeper sweep of web frontend, x402 payments, periphery contracts (DeRiskEvaluator, registries), test coverage.

## Summary

Every Critical/High from the first review has been fixed, and the fixes are well-reasoned rather than mechanical — the de-risk `minOut` floor in particular is a thoughtful piece of work. The deeper sweep surfaced one net-new Medium worth fixing (the agent's outbound x402 payment has no spend cap) plus a handful of Low items in the web and ops layers. **Net posture has clearly improved since pass 1.**

Two scary-sounding items from my own sub-scans were **false alarms** and are called out below so nobody chases them.

**Verdict: Approve with minor changes** (the pass-1 blockers are resolved; remaining items are Medium/Low hardening).

## Pass-1 fixes — verified against HEAD

| Pass-1 ID | Fix | Verified |
|-----------|-----|----------|
| C1 — USDY sell off by 10¹² | `executor/index.ts:325` now `10n ** 30n`; regression test in `executor.test.ts` | ✅ correct |
| C2 — de-risk `minOut = 0` | New `YieldVault._deRiskMinOut()` derives a floor from **min(oracle NAV, agent spot)** × (1 − maxSlippage), falls back to NAV on a dead oracle, returns 0 only when the bucket is empty; `_unwindUsdyToAusd` now passes it through. Test: `Phase2a` underpay-reverts case | ✅ sound — survives a real depeg yet blocks gross MEV |
| H1 — dead on-chain staleness guard | Resolved by documentation: code comments + `docs/spec.md §2.3` state the range/age checks are inert on Mantle and the real backstop is `UsdyAdapter._requireOracleFresh`/`getPrice()` reverting on a dead oracle. Guard logic kept for chains that expose `updatedAt`/range | ✅ acceptable (an on-chain `updatedAt` feed isn't available on Mantle's Ondo oracle) |
| H2 — allocator-supplied DEX spot | Documented as a trusted input; bounded by the $5k notional + 60% weight caps. `CustosDeRiskEvaluator` reads NAV on-chain so only the spot is keeper-supplied | ✅ acknowledged; residual trust noted below |
| H3 — instant guardrail swap | `Guardrails.setConfig` is now a one-shot bootstrap that **seals**, then all changes go through `queueConfig`/`activateConfig` behind the 48h timelock; vault `setGuardrails` → `queueGuardrails`/`activateGuardrails` with the same timelock. Tests in `GovernanceTimelock.t.sol` | ✅ correct |
| M1 — orphan adapter on oracle outage | `removeStrategy` now gates on `adapter.hasAssets()` (balance-based) instead of `totalAssets()` (oracle-priced) | ✅ correct |
| M2 — LLM-news de-risk blocked by move cap | `validateRebalance` exempts `_isRiskReducing(pre, post)` from the move cap. The predicate requires `post.USDY < pre.USDY` **and** IDLE/AAVE/AUSD all non-decreasing — so it can only ever exempt a pure de-risk, never a risk-increasing or risk-neutral reshuffle. All other guardrails still apply. Tests in `MoveCapExemption.t.sol` | ✅ correct and not abusable |

`_isRiskReducing` was the one I scrutinized hardest (an over-broad exemption would reopen the move-cap hole); it's tightly scoped. Good.

## ⚠️ False alarms (do not chase)

- **"3 critical Solidity file truncations / won't compile" (Guardrails, IStrategyAdapter, CustosDeRiskEvaluator).** This is a **mount/sync artifact in the review session**, not your code. The working-tree copies were served truncated (git index locks were unwritable, `git diff` errored with chunk-offset). The committed HEAD versions are intact: brace counts balance (41/41, 63/63, 16/16, 1/1) and all functions close cleanly. Nothing to fix.
- **"Critical ABI drift — `web/src/lib/vaultAbi.ts` missing `rebalance`/`deRisk`/events."** The web app never calls `rebalance`/`deRisk` (those are ALLOCATOR-only, sent by the agent). The UI reads vault state and watches `DecisionRecorded`, both present. At most a Low nicety if you later want to render post-rebalance weights from the `Rebalanced` event. Not a defect.

## Net-new findings

| # | File | Sev | Issue |
|---|------|-----|-------|
| N1 | `payments/x402.ts` `buildAuthorization` + `payments/evidence.ts` | **Medium** | The agent-pays (premium-evidence) path signs an EIP-3009 authorization whose `value` is taken straight from the counterparty's 402 response (`requirements.maxAmountRequired`). There is **no client-side max-spend cap.** A malicious/compromised premium-feed URL can demand an arbitrary amount and the agent signs it; if the counterparty submits it on-chain, the payer overpays up to its balance. Bounded by it being an opt-in feature against an operator-configured URL, but signing a counterparty-dictated amount is a footgun. **Fix:** add `X402_MAX_PRICE_BASE_UNITS` and reject `maxAmountRequired` above it before signing. |
| N2 | `llm/evidence.ts` → `llm/signals.ts` | **Medium** | Evidence summaries are scraped from external pages and fed into the LLM context. A hostile feed can fabricate an evidence item whose `id` satisfies the `deRisk` evidence-citation check (`signals.ts` `clampVerdict`), triggering an unwarranted LLM de-risk → realized swap slippage + lost yield + reputation noise. **Blast radius is capped** by the tighten-only rule and on-chain guardrails (it can never *increase* risk or touch custody), so this is an availability/griefing vector, not a fund-loss one. **Fix:** allow-list evidence sources (or require signed attestations) before they can satisfy the de-risk citation gate. |
| N3 | `payments/verifier.ts` (verify-only mode) | **Low** | The inbound x402 verifier checks bounds + signature recovery but tracks no nonce off-chain, so in verify-only mode (`X402_SETTLE_ONCHAIN=false`) a replayed `X-PAYMENT` can unlock `/risk-score` repeatedly without settlement. Impact is a $0.01 informational endpoint; the on-chain settle path is replay-protected by EIP-3009's own nonce. **Fix:** cache spent nonces until `validBefore`, or only sell via the on-chain-settling verifier. |
| N4 | `alerts.ts` | **Low** | Telegram/Discord `fetch` calls have no timeout/AbortController; a hung webhook can stall the scheduler's `onCycle` callback and delay the next cycle. Add a ~5s timeout. |
| N5 | `web/src/lib/useGuardianData.ts:100` | **Low** | `getLogs({ fromBlock: DEPLOY_BLOCK })` with no `toBlock` cap can exceed RPC provider per-call log-range limits on Mantle; failure degrades to a watch-only (empty history) feed. Page the range or checkpoint it. Mitigated by `DEPLOY_BLOCK` scoping + the catch fallback. |
| N6 | `web/src/modals/TradeModals.tsx` | **Low** | After a deposit/redeem receipt confirms, vault balances aren't query-invalidated, so the position display can lag up to the 15s poll interval (confusing; risks a perceived duplicate action). Invalidate the vault queries on confirmation. |
| N7 | `executor/ipfs.ts` | **Info** | The `data:`-URI fallback when IPFS pinning fails isn't content-addressed, so an evidence bundle pinned that way may not resolve long-term. `rationaleHash` binding is still correct, so it's an auditability/durability nit, not a security issue. |

## Residual notes from pass 1 (still accepted, not regressions)

H2's trust model stands: the depeg guard's DEX spot on the *entry* path is supplied by the ALLOCATOR key it constrains, with no on-chain cross-check. You've documented it and bounded it with the $5k notional cap; just keep it on the risk register — if Mantle USDY liquidity ever deepens enough for an on-chain TWAP, that's the proper close.

## What looks good

The fix quality is high: `_deRiskMinOut` correctly discounts to the real exit price during a depeg instead of naively flooring at NAV (which would revert the exit exactly when you need it), and `_isRiskReducing` is scoped so the move-cap exemption can't be turned into a bypass. The governance timelock is symmetric across `Guardrails.setConfig` and vault `setGuardrails`, with a clean bootstrap-then-seal pattern. Regression tests exist for C1, C2, H3, and M2 (`executor.test.ts`, `Phase2a`, `GovernanceTimelock.t.sol`, `MoveCapExemption.t.sol`). `CustosDeRiskEvaluator` reads NAV on-chain and fail-closed-reverts (`OracleUnavailable`) when the oracle is down — the right call for a contract whose whole job is verification. Payment EIP-712 domains correctly bind `chainId` + `verifyingContract`; nonces use CSPRNG; the on-chain settle path checks receipt status before unlocking.

## Recommended order

1. N1 (x402 max-spend cap) — it's the only net-new item that can move real value.
2. N2 (evidence allow-list) and N4 (alert timeout) — cheap hardening of the autonomous loop.
3. N3, N5, N6 — Low ops/UX cleanup. N7 informational.
