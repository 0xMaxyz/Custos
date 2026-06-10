# Code Review (Pass 3) — Custos

**Reviewer:** senior DeFi full-stack pass · **Date:** 2026-06-08 · **Against:** HEAD `908912c` ("fix issues") · **Scope:** verify the pass-2 findings (N1–N7) are correctly resolved; scan the commit for regressions.

## Summary

Commit `908912c` addresses every actionable pass-2 finding (N1–N6), and each fix is correct, minimal, and accompanied by a test. This is a clean close-out — nothing in the commit introduces a regression. Two cosmetic nits remain, neither functional.

**Verdict: Approve.**

> Note: my session still sees the working tree truncated (a mount glitch — files on disk are short prefixes of the committed blobs), so this review is against committed HEAD `908912c`, which is intact.

## Fix verification

| Pass-2 ID | Fix in `908912c` | Verified |
|-----------|------------------|----------|
| **N1** — x402 agent-pays had no spend cap | `createPayment` now rejects when `requirements.maxAmountRequired > maxAmountBaseUnits` **before** signing; cap threaded config → `index.ts` (`maxPriceBaseUnits: config.x402MaxPriceBaseUnits`) → `buildPaidEvidenceFetcher` → `payAndFetch`. Config `superRefine` makes `X402_MAX_PRICE_BASE_UNITS` **required** when `X402_PREMIUM_FEED_URL` is set. Tests added in `x402.test.ts`. | ✅ correct — counterparty can no longer dictate the signed amount |
| **N2** — hostile feed could fabricate evidence to trigger a de-risk | `CURATED_EVIDENCE_SOURCES` (derived from `FEEDS`, so no drift) passed as `trustedEvidenceSources`; `clampVerdict` now only lets cited evidence whose `source` is allow-listed keep `deRisk=true`. Un-vetted sources still inform the model but can't unlock a de-risk. Executor wires it at `executor/index.ts:105`. | ✅ correct — back-compat preserved (undefined ⇒ all eligible) |
| **N3** — verify-only x402 had no replay guard | `replayGuardedVerifier(signatureVerifyingVerifier())` wraps the verify-only path in `index.ts`; consumes a nonce only for a genuinely valid receipt; in-memory `NonceStore` **prunes expired keys on every call** (bounded memory) and keys on `from:nonce`. On-chain settle path remains single-use via the EIP-3009 nonce. Tests in `verifier.test.ts`. | ✅ correct |
| **N4** — alert webhooks had no timeout | New `_postJson` wraps Telegram/Discord POSTs in an `AbortController` with `DEFAULT_ALERT_TIMEOUT_MS = 5_000`, `clearTimeout` in `finally`; a hung webhook is aborted and swallowed by the caller, so it can't stall `onCycle`. Tests in `alerts.test.ts`. | ✅ correct |
| **N5** — web `getLogs` range could exceed RPC caps | Extracted `getLogsPaged()` helper paging `[fromBlock, latest]` in 10k-block windows; `useDecisions` now calls it. Pure and unit-tested (`useGuardianData.test.ts`). | ✅ correct |
| **N6** — stale vault balance after a confirmed tx | Both deposit and withdraw confirm-effects call `invalidateVaultReads(queryClient)` (invalidates wagmi `readContract(s)` queries) so `useVaultData` refetches immediately instead of waiting up to 15s. | ✅ correct |
| N7 (Info) — `data:` IPFS fallback not content-addressed | Not changed; was informational/durability only. | — (accepted) |

Test coverage tracks the fixes: `x402.test.ts` (+38), `verifier.test.ts` (+46), `alerts.test.ts` (+31), `config.test.ts` (+12), `executor.test.ts` (+30), `client.test.ts` (+35), `useGuardianData.test.ts` (+36).

## Remaining nits (cosmetic, non-blocking)

| # | File | Sev | Note |
|---|------|-----|------|
| P1 | `web/src/modals/TradeModals.tsx` (WithdrawModal) | Trivial | The deposit effect's dep array was updated to include `queryClient`; the **withdraw** effect still reads `queryClient`/`usdcOut`/`txHash` but lists only `[redeemConfirmed]`. Functionally fine (`useQueryClient` returns a stable ref and the effect is gated on the boolean flip), but it's an inconsistent exhaustive-deps pattern between the two modals — tidy it for lint parity. |
| P2 | `web/src/modals/TradeModals.tsx` `invalidateVaultReads` | Trivial | Invalidates **all** `readContract`/`readContracts` queries app-wide, not just vault reads. Harmless (a post-tx refresh is desirable) and simpler than tagging query keys, but worth a comment that it's intentionally broad. |

## Still on the risk register (unchanged, by design)

H2 from pass 1 stands: the depeg guard's DEX **spot** on the entry path is supplied by the ALLOCATOR key it constrains, with no on-chain cross-check — documented and bounded by the $5k USDY notional cap. Close it with an on-chain TWAP if/when Mantle USDY liquidity deepens enough to support one. Nothing to do now.

## Bottom line

Three review passes in, every Critical/High/Medium finding has been fixed with a sound, tested implementation, and the remaining items are two lint-level cosmetics plus one accepted design trade-off. The control-plane invariants (tighten-only LLM, guardrails-final, pinned-router custody, timelocked guardrail brain) are intact. Ship it.
