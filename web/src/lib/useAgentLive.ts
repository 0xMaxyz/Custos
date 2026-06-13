// Live on-chain guardrail parameters + the live x402 offer for the Agent page.
//
// Guardrails are read once and cached for the session (they change rarely and only
// via a timelocked governance action). The x402 offer is read straight from the
// agent's 402-gated `/risk-score` challenge so it reflects what the agent actually
// accepts right now — not a fixture or a possibly-stale pinned card.

import { useEffect, useState } from "react";
import { useReadContract, useChainId } from "wagmi";

import { resolveDeployment } from "./deployment";
import { GUARDRAILS_ABI } from "./vaultAbi";

const AGENT_API_URL = import.meta.env.VITE_AGENT_API_URL ?? "";

export interface GuardrailRow {
  key: string;
  label: string;
  value: string;
  field: string;
}

const pct = (bps: number): string => `${bps / 100}%`;
const hours = (s: number): string => `${Math.round(s / 3600)}h`;
const usd = (baseUnits: bigint): string => `$${(Number(baseUnits) / 1e6).toLocaleString()}`;

interface GuardrailsConfig {
  maxWeightBps: readonly [number, number, number, number];
  minIdleBps: number;
  minInstantLiquidityBps: number;
  maxUsdyNotionalUsdc: bigint;
  maxSlippageBps: number;
  maxRebalanceMoveBps: number;
  minRebalanceInterval: number;
  tvlCap: bigint;
  perTxDepositCap: bigint;
  addStrategyTimelock: number;
  pegWarnBps: number;
  pegBlockBps: number;
  pegDeRiskBps: number;
}

/**
 * Live guardrail parameters from `Guardrails.config()`, mapped to display rows.
 * `isLive` is false until the read resolves (callers fall back to the fixture).
 */
export function useGuardrails(): { rows: GuardrailRow[]; isLive: boolean } {
  const chainId = useChainId();
  const address = resolveDeployment(chainId).guardrails || undefined;
  const { data } = useReadContract({
    address,
    abi: GUARDRAILS_ABI,
    functionName: "config",
    // Guardrail config changes only via a timelocked governance action — read once
    // and keep it for the session rather than polling.
    query: { enabled: Boolean(address), staleTime: Infinity, gcTime: Infinity },
  });

  if (!data) return { rows: [], isLive: false };
  const c = data as unknown as GuardrailsConfig;
  const rows: GuardrailRow[] = [
    { key: "maxUsdy", label: "Max USDY weight", value: pct(c.maxWeightBps[2]), field: "maxWeightBps[USDY]" },
    { key: "maxAave", label: "Max Aave weight", value: pct(c.maxWeightBps[1]), field: "maxWeightBps[AAVE]" },
    { key: "minIdle", label: "Min idle", value: pct(c.minIdleBps), field: "minIdleBps" },
    { key: "minInstant", label: "Min instant-liquidity", value: pct(c.minInstantLiquidityBps), field: "minInstantLiquidityBps" },
    { key: "maxSlippage", label: "Max slippage", value: pct(c.maxSlippageBps), field: "maxSlippageBps" },
    { key: "maxMove", label: "Max rebalance move", value: pct(c.maxRebalanceMoveBps), field: "maxRebalanceMoveBps" },
    { key: "minInterval", label: "Min rebalance interval", value: hours(c.minRebalanceInterval), field: "minRebalanceInterval" },
    { key: "pegThresholds", label: "Peg warn / block / de-risk", value: `${c.pegWarnBps / 100} / ${c.pegBlockBps / 100} / ${c.pegDeRiskBps / 100}%`, field: "pegWarn/Block/DeRiskBps" },
    { key: "usdyNotional", label: "Max USDY notional", value: usd(c.maxUsdyNotionalUsdc), field: "maxUsdyNotionalUsdc" },
    { key: "tvlCap", label: "TVL cap", value: usd(c.tvlCap), field: "tvlCap" },
    { key: "perTxCap", label: "Per-tx deposit cap", value: usd(c.perTxDepositCap), field: "perTxDepositCap" },
    { key: "addTimelock", label: "Add-strategy timelock", value: hours(c.addStrategyTimelock), field: "addStrategyTimelock" },
  ];
  return { rows, isLive: true };
}

export interface X402Offer {
  payTo: `0x${string}`;
  asset: `0x${string}`;
  priceBaseUnits: string;
  network: string;
  resource: string;
  description: string;
  tokenName?: string;
}

/**
 * Live x402 sell-side offer, read from the agent's 402-gated `/risk-score` endpoint.
 * A `402 Payment Required` body carries the `accepts[]` requirements — so a present
 * offer means the agent is actively accepting payments. `configured` is false when
 * the endpoint is open/unconfigured or the agent API isn't set.
 */
export function useX402Offer(): { offer: X402Offer | undefined; loading: boolean; configured: boolean } {
  const [offer, setOffer] = useState<X402Offer | undefined>(undefined);
  const [loading, setLoading] = useState(AGENT_API_URL.length > 0);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    if (!AGENT_API_URL) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); }, 8_000);
    fetch(`${AGENT_API_URL}/risk-score`, { headers: { accept: "application/json" }, signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ accepts?: Array<Record<string, unknown>> }>)
      .then((body) => {
        if (cancelled) return;
        const a = body.accepts?.[0];
        if (a && typeof a.payTo === "string") {
          const tokenName = (a.extra as { name?: string } | undefined)?.name;
          setOffer({
            payTo: a.payTo as `0x${string}`,
            asset: a.asset as `0x${string}`,
            priceBaseUnits: String(a.maxAmountRequired ?? "0"),
            network: String(a.network ?? "mantle"),
            resource: String(a.resource ?? ""),
            description: String(a.description ?? ""),
            ...(tokenName ? { tokenName } : {}),
          });
          setConfigured(true);
        }
      })
      .catch(() => { /* endpoint open or unreachable — leave unconfigured */ })
      .finally(() => { if (!cancelled) setLoading(false); clearTimeout(timer); });
    return () => { cancelled = true; clearTimeout(timer); ctrl.abort(); };
  }, []);

  return { offer, loading, configured };
}
