/**
 * A2.1 — Live risk-radar data hook.
 *
 * Fetches `GET /snapshot` from the agent API when `VITE_AGENT_API_URL` is set,
 * falling back to the static fixture for demo/dev. Auto-refreshes every 15s.
 */

import { useEffect, useRef, useState } from "react";
import { insights } from "./data";

const AGENT_API_URL = import.meta.env.VITE_AGENT_API_URL ?? "";

/** Subset of the agent's `/snapshot` (ExplainContext) we consume here. */
interface SnapshotDto {
  asOf: string;
  pegDeviationBps: number;
  usdyOracleNavUsdc: string;
  usdyDexSpotUsdc: string;
  usdyImpliedApyBps: number;
  aaveUsdcSupplyApyBps: number;
  aaveUtilizationBps: number;
  aaveWithdrawableUsdc: string;
  oracleRangeEnd: string;
  ausdBackingRatioBps: number;
}

/** Scalar live metrics derived from ExplainContext (or fixture). */
export interface InsightsSnapshot {
  asOf: string;
  /** Whether the data is from the live agent (true) or fixture (false). */
  live: boolean;
  pegDeviationBps: number;
  usdyOracleNavUsdc: string;
  usdyDexSpotUsdc: string;
  usdyImpliedApyBps: number;
  aaveUsdcSupplyApyBps: number;
  aaveUtilizationBps: number;
  aaveWithdrawableUsdc: string;
  ausdBackingRatioBps: number;
  oracleRangeEnd?: string;
}

export function fixtureSnapshot(): InsightsSnapshot {
  return {
    asOf: new Date().toISOString(),
    live: false,
    pegDeviationBps: 20,
    usdyOracleNavUsdc: "1.0832",
    usdyDexSpotUsdc: "1.0810",
    usdyImpliedApyBps: 452,
    aaveUsdcSupplyApyBps: insights.aaveSupplyApyBps,
    aaveUtilizationBps: insights.aaveUtilizationBps,
    aaveWithdrawableUsdc: insights.aaveWithdrawableUsdc,
    ausdBackingRatioBps: Math.round(insights.porRatioPct * 100),
    oracleRangeEnd: insights.oracleRangeEnd,
  };
}

export async function fetchSnapshot(): Promise<InsightsSnapshot> {
  const res = await fetch(`${AGENT_API_URL}/snapshot`);
  if (!res.ok) throw new Error(`/snapshot ${res.status}`);
  const ctx = (await res.json()) as SnapshotDto;
  return {
    asOf: ctx.asOf,
    live: true,
    pegDeviationBps: ctx.pegDeviationBps ?? 0,
    usdyOracleNavUsdc: ctx.usdyOracleNavUsdc ?? "unavailable",
    usdyDexSpotUsdc: ctx.usdyDexSpotUsdc ?? "unavailable",
    usdyImpliedApyBps: ctx.usdyImpliedApyBps ?? 0,
    aaveUsdcSupplyApyBps: ctx.aaveUsdcSupplyApyBps ?? 0,
    aaveUtilizationBps: ctx.aaveUtilizationBps ?? 0,
    aaveWithdrawableUsdc: ctx.aaveWithdrawableUsdc ?? "0.00",
    ausdBackingRatioBps: ctx.ausdBackingRatioBps ?? 0,
    // Empty string from the agent (unsupported range) → fixture fallback.
    ...(ctx.oracleRangeEnd ? { oracleRangeEnd: ctx.oracleRangeEnd } : {}),
  };
}

export interface UseInsightsDataResult {
  snapshot: InsightsSnapshot;
  loading: boolean;
  lastUpdated: Date | undefined;
  /** True when live mode is configured but the latest /snapshot fetch failed —
   *  the radar is showing stale/fixture data and operators should know. */
  stale: boolean;
}

const REFRESH_INTERVAL_MS = 15_000;

export function useInsightsData(): UseInsightsDataResult {
  const [snapshot, setSnapshot] = useState<InsightsSnapshot>(fixtureSnapshot);
  const [loading, setLoading] = useState(AGENT_API_URL.length > 0);
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!AGENT_API_URL) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const fetch = async () => {
      try {
        const snap = await fetchSnapshot();
        if (!cancelled) {
          setSnapshot(snap);
          setLastUpdated(new Date());
          setStale(false);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setStale(true);
          setLoading(false);
        }
      }
    };

    void fetch();
    timer.current = setInterval(() => { void fetch(); }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  return { snapshot, loading, lastUpdated, stale };
}
