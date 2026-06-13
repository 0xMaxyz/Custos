/**
 * A2.1 — Live risk-radar data hook.
 *
 * Fetches `GET /snapshot` from the agent API when `VITE_AGENT_API_URL` is set,
 * falling back to the static fixture for demo/dev. Auto-refreshes every 15s.
 */

import { useEffect, useRef, useState } from "react";
import { insights, type RiskLevelKey, type SignalTypeKey } from "./data";

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

/** Abort a /snapshot fetch that hangs so the radar never blocks the page (the
 *  agent can be briefly slow/unreachable on a cold cache). */
const FETCH_TIMEOUT_MS = 8_000;

export async function fetchSnapshot(): Promise<InsightsSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AGENT_API_URL}/snapshot`, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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
// The agent returns 503 ("try again shortly") on a cold/stale snapshot cache; retry
// a few times with a short backoff before falling back to stale/fixture data.
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

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
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const snap = await fetchSnapshot();
          if (!cancelled) {
            setSnapshot(snap);
            setLastUpdated(new Date());
            setStale(false);
            setLoading(false);
          }
          return;
        } catch {
          if (cancelled) return;
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
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

export interface WatchRow {
  label: string;
  value: string;
  threshold: string;
  status: RiskLevelKey;
  signal: SignalTypeKey;
}

/** Build the agent watchlist from a live snapshot (mirrors the fixture row shape). */
export function buildLiveWatchlist(s: InsightsSnapshot): WatchRow[] {
  const pegStatus: RiskLevelKey =
    s.pegDeviationBps >= 100 ? "DERISK" : s.pegDeviationBps >= 50 ? "CAUTION" : "NORMAL";
  const navUnavailable = s.usdyOracleNavUsdc === "unavailable";
  return [
    {
      label: "USDY peg",
      value: `${(s.pegDeviationBps / 100).toFixed(2)}% from NAV`,
      threshold: "warn 0.3 / block 0.5 / derisk 1.0%",
      status: pegStatus,
      signal: "PEG",
    },
    {
      label: "Oracle NAV",
      value: navUnavailable ? "unavailable" : `$${s.usdyOracleNavUsdc} / USDY`,
      threshold: s.oracleRangeEnd ? `valid until ${s.oracleRangeEnd.slice(0, 10)}` : "live read",
      status: navUnavailable ? "CAUTION" : "NORMAL",
      signal: "ORACLE",
    },
    {
      label: "Aave utilization",
      value: `${Math.round(s.aaveUtilizationBps / 100)}%`,
      threshold: "—",
      status: "NORMAL",
      signal: "LIQUIDITY",
    },
    {
      label: "AUSD reserves (PoR)",
      value: s.ausdBackingRatioBps > 0 ? `${(s.ausdBackingRatioBps / 100).toFixed(2)}% reserved` : "unavailable",
      threshold: "—",
      status: "NORMAL",
      signal: "ATTESTATION",
    },
  ];
}
