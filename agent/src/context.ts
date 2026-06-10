import { assess } from "./risk/engine.js";
import { buildExplainContext, type ExplainContext } from "./llm/explain.js";
import type { Decision, MarketSnapshot } from "./types.js";

/**
 * Grounding-context freshness helper (O7).
 *
 * Both `/ask`/`/snapshot` and the PAID `/risk-score` endpoint are grounded on the
 * same `ExplainContext` (snapshot → deterministic assess → recent decisions),
 * coalesced behind a short TTL cache so a chatty session doesn't re-snapshot on
 * every call. But the paid path can't tolerate the full 10s staleness: during a
 * fast depeg a 10s-old "all clear" sold for money is unacceptable. So callers pass
 * their own `maxAgeMs` tolerance.
 *
 * When the cached context is older than `maxAgeMs`, this re-snapshots. The
 * snapshotter has its OWN, longer (~15s) source-read cache, so we call
 * `invalidate()` first — otherwise the "re-snapshot" would just return the
 * snapshotter's still-cached source data and the paid signal would not actually be
 * fresh. Pure + injectable so the freshness logic is unit-testable without the
 * index.ts startup wiring.
 */

export interface FreshContextResult {
  readonly value: ExplainContext;
  readonly cache: { at: number; value: ExplainContext };
}

export interface ContextSnapshotter {
  snapshot: () => Promise<MarketSnapshot>;
  invalidate: () => void;
}

export async function computeFreshContext(
  snapshotter: ContextSnapshotter,
  decisions: readonly Decision[],
  cache: { at: number; value: ExplainContext } | undefined,
  maxAgeMs: number,
  now: number,
): Promise<FreshContextResult> {
  if (cache && now - cache.at < maxAgeMs) {
    return { value: cache.value, cache };
  }
  // Cache too stale for this caller's tolerance — drop the snapshotter's own
  // (longer-TTL) cached source reads so the next snapshot is genuinely fresh.
  snapshotter.invalidate();
  const snapshot = await snapshotter.snapshot();
  const assessment = assess(snapshot);
  const value = buildExplainContext(snapshot, assessment, decisions);
  return { value, cache: { at: now, value } };
}
