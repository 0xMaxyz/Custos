// Allocator page (§5.x). ALLOCATOR-gated manual rebalance.
//
// The autonomous engine only maintains/de-risks the RWA position — it never grows an
// allocation from idle. This page is the manual seed: an ALLOCATOR sets a full target
// allocation across all four buckets and submits it as a SINGLE rebalance() (so multiple
// buckets move in one tx, consuming one rebalance-interval slot). USDY/AUSD legs fetch
// 1delta calldata from the agent (key stays server-side); Aave/idle need no swap. The
// plan is validated against the on-chain Guardrails mirror, then simulated, before signing.

import { useState, useEffect } from "react";
import { useAccount, useChainId, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, keccak256, toBytes, BaseError, ContractFunctionRevertedError } from "viem";
import { MAX_SLIPPAGE_BPS, MAX_USDY_NOTIONAL_USDC, MIN_IDLE_BPS, MIN_INSTANT_LIQUIDITY_BPS, MAX_REBALANCE_MOVE_BPS, MAX_WEIGHT_BPS, Bucket } from "@custos/shared";
import { Icon } from "../components/Icons";
import { Card, Skeleton, Spinner } from "../components/Components";
import type { WeightsBps } from "../lib/data";
import { useVaultData } from "../lib/useVaultData";
import { useAllocator } from "../lib/useAllocator";
import { useInsightsData } from "../lib/useInsightsData";
import { resolveDeployment } from "../lib/deployment";
import { VAULT_ABI } from "../lib/vaultAbi";
import { planRebalance, checkUsdySpot, describeGuardrailReason } from "../lib/allocatorRebalance";
import { fetchSwapQuote, swapQuoteAvailable } from "../lib/swapQuote";
import type { ToastPayload } from "../modals/TradeModals";

type BucketKey = "AAVE" | "USDY" | "AUSD";
const EDITABLE: BucketKey[] = ["AAVE", "USDY", "AUSD"];

function pctStr(bps: number): string { return (bps / 100).toFixed(1); }
function bpsFromPct(s: string): number { return Math.round((parseFloat(s || "0") || 0) * 100); }

/**
 * Turn a rebalance failure into a user-readable message. When the revert is
 * `GuardrailsRejected(bytes4 reason)` (now decodable via vaultAbi.ts), surface the
 * specific guardrail that tripped instead of a raw 4-byte selector.
 */
function rebalanceErrorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "GuardrailsRejected") {
      const reason = revert.data.args?.[0];
      if (typeof reason === "string") return describeGuardrailReason(reason);
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : "Check your wallet and the guardrails, then try again.";
}

function WeightBar({ label, fromBps, toBps }: { label: string; fromBps: number; toBps: number }) {
  const changed = fromBps !== toBps;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8125rem", marginBottom: 3 }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span className="mono">
          <span style={{ color: "var(--muted)" }}>{pctStr(fromBps)}%</span>
          {changed && <> → <span style={{ fontWeight: 600 }}>{pctStr(toBps)}%</span></>}
        </span>
      </div>
      <div style={{ height: 7, background: "var(--base-200)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, fromBps / 100)}%`, background: "var(--border-strong)", opacity: 0.5 }} />
        <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, toBps / 100)}%`, background: "var(--primary)" }} />
      </div>
    </div>
  );
}

function GuardrailFacts() {
  const facts = [
    { k: "Min idle", v: `${(MIN_IDLE_BPS / 100).toFixed(0)}%` },
    { k: "Min instant liquidity", v: `${(MIN_INSTANT_LIQUIDITY_BPS / 100).toFixed(0)}%` },
    { k: "Max move / rebalance", v: `${(MAX_REBALANCE_MOVE_BPS / 100).toFixed(0)}%` },
    { k: "Max USDY weight", v: `${(MAX_WEIGHT_BPS[Bucket.USDY] / 100).toFixed(0)}%` },
    { k: "Max USDY notional", v: `$${(MAX_USDY_NOTIONAL_USDC / 1e6).toLocaleString()}` },
    { k: "Max slippage", v: `${(MAX_SLIPPAGE_BPS / 100).toFixed(2)}%` },
  ];
  return (
    <div className="guardrail-grid">
      {facts.map((f) => (
        <div key={f.k} className="guardrail">
          <div style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{f.k}</div>
          <div className="mono" style={{ fontWeight: 600, fontSize: "1rem", marginTop: 3 }}>{f.v}</div>
        </div>
      ))}
    </div>
  );
}

function RebalanceForm({ onToast }: { onToast: (t: ToastPayload) => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const VAULT_ADDRESS = resolveDeployment(chainId).vault as `0x${string}`;

  const { vault } = useVaultData(address);
  const { lastRebalanceAt } = useAllocator(address);
  const { snapshot } = useInsightsData();
  const cur = vault.weightsBps;

  const [pct, setPct] = useState<Record<BucketKey, string>>({ AAVE: pctStr(cur.AAVE), USDY: pctStr(cur.USDY), AUSD: pctStr(cur.AUSD) });
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [txHash, setTxHash] = useState("");

  const tvlRaw = (() => { try { return parseUnits(vault.tvlUsdc || "0", 6); } catch { return 0n; } })();
  const aaveWithdrawableBps = (() => {
    if (!snapshot.live || tvlRaw <= 0n) return 10_000;
    try {
      const wd = parseUnits(snapshot.aaveWithdrawableUsdc || "0", 6);
      const bps = Number((wd * 10_000n) / tvlRaw);
      return bps > 10_000 ? 10_000 : bps;
    } catch { return 10_000; }
  })();

  const aaveBps = bpsFromPct(pct.AAVE);
  const usdyBps = bpsFromPct(pct.USDY);
  const ausdBps = bpsFromPct(pct.AUSD);
  const idleBps = 10_000 - aaveBps - usdyBps - ausdBps;
  const target: WeightsBps = { IDLE: idleBps, AAVE: aaveBps, USDY: usdyBps, AUSD: ausdBps };

  const plan = planRebalance({
    current: cur,
    target,
    tvlRaw,
    pegDeviationBps: snapshot.live ? snapshot.pegDeviationBps : 0,
    aaveWithdrawableBps,
    lastRebalanceAt,
    nowSec: Math.floor(Date.now() / 1000),
  });

  const needsSwap = plan.legs.length > 0;
  const swapBlocked = needsSwap && !swapQuoteAvailable;
  const idleError = idleBps < 0 ? "Weights exceed 100%" : "";
  const error = idleError || plan.error || (swapBlocked ? "Agent API not configured — USDY/AUSD swaps unavailable" : "");
  const valid = error === "";

  const { writeContractAsync: writeRebalance } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({
    hash: txHash ? (txHash as `0x${string}`) : undefined,
    query: { enabled: txHash.length > 2 },
  });

  useEffect(() => {
    if (confirmed && busy) {
      setBusy(false);
      setTxHash("");
      void queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      void queryClient.invalidateQueries({ queryKey: ["readContract"] });
      onToast({ kind: "success", title: "Rebalance confirmed", body: "Target allocation applied." });
    }
  }, [confirmed, busy, queryClient, onToast]);

  const run = async () => {
    if (!valid || !address || !publicClient) return;
    try {
      const swapData: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = ["0x", "0x", "0x", "0x"];
      let usdyDexSpot = 0n;

      if (needsSwap) {
        setBusy(true);
        setBusyLabel("Fetching routes…");
        for (const leg of plan.legs) {
          const q = await fetchSwapQuote({ bucket: leg.bucket, side: leg.side, usdcAmount: leg.usdcAmount.toString() });
          swapData[q.bucketIndex] = q.calldata;
          if (leg.bucket === "USDY" && leg.side === "deposit") usdyDexSpot = BigInt(q.usdyDexSpotUsdc || "0");
        }
      }

      // Mirror the on-chain UsdySpotRequired guard: the pure planRebalance check runs
      // before the quote resolves, so re-check here now that usdyDexSpot is known.
      const spotErr = checkUsdySpot(cur, target, usdyDexSpot);
      if (spotErr) throw new Error(spotErr);

      const args = [
        [target.IDLE, target.AAVE, target.USDY, target.AUSD] as const,
        swapData,
        "manual:web-allocator-rebalance",
        keccak256(toBytes("manual:web-allocator-rebalance")),
        usdyDexSpot,
      ] as const;

      // Pre-flight: simulate the full rebalance (incl. the swap legs) so a move that
      // would revert on-chain fails here, before the user signs anything.
      setBusy(true);
      setBusyLabel("Simulating…");
      await publicClient.simulateContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "rebalance", args, account: address });

      setBusyLabel("Rebalancing…");
      const hash = await writeRebalance({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "rebalance", args });
      setTxHash(hash);
    } catch (err) {
      setBusy(false);
      onToast({ kind: "error", title: "Rebalance failed", body: rebalanceErrorMessage(err) });
    }
  };

  const setBucketMax = (b: BucketKey) => {
    // Push this bucket to the largest value the guardrails allow given the others.
    const cap = MAX_WEIGHT_BPS[Bucket[b]];
    const otherEditable = EDITABLE.filter((k) => k !== b).reduce((s, k) => s + bpsFromPct(pct[k]), 0);
    const room = 10_000 - MIN_IDLE_BPS - otherEditable;
    setPct((p) => ({ ...p, [b]: pctStr(Math.max(0, Math.min(cap, room))) }));
  };

  return (
    <>
      <Card>
        <span className="cs-card-title"><Icon name="gauge" size={14} />Target allocation</span>
        <div style={{ display: "grid", gap: 14 }}>
          {EDITABLE.map((b) => (
            <div key={b}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label style={{ width: 56, fontWeight: 600, fontSize: "0.875rem" }}>{b}</label>
                <input className="amount-input" style={{ flex: 1, fontSize: "1.125rem" }} inputMode="decimal" placeholder="0.0"
                  value={pct[b]} disabled={busy}
                  onChange={(e) => setPct((p) => ({ ...p, [b]: e.target.value.replace(/[^0-9.]/g, "") }))}
                  aria-label={`${b} target percent`} />
                <span style={{ fontWeight: 700, color: "var(--muted)" }}>%</span>
                <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy} onClick={() => setBucketMax(b)}>Max</button>
              </div>
            </div>
          ))}
          <div className="kvrow" style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
            <span className="k">Idle (remainder)</span>
            <span className="v mono" style={{ color: idleBps < MIN_IDLE_BPS ? "var(--error)" : undefined }}>{pctStr(Math.max(0, idleBps))}%</span>
          </div>
        </div>

        {error && (
          <div className="disclosure" style={{ marginTop: 14, color: "var(--error)", background: "var(--error-soft)" }}>
            <Icon name="alert-triangle" size={15} />{error}
          </div>
        )}

        <button className="cs-btn cs-btn-primary cs-btn-block cs-btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy} onClick={() => void run()}>
          {busy ? <><Spinner /> {busyLabel}</> : valid ? "Simulate & rebalance" : "Adjust allocation"}
        </button>
      </Card>

      <Card>
        <span className="cs-card-title"><Icon name="line-chart" size={14} />Current → target</span>
        <div style={{ display: "grid", gap: 12 }}>
          <WeightBar label="Idle" fromBps={cur.IDLE} toBps={Math.max(0, idleBps)} />
          <WeightBar label="Aave" fromBps={cur.AAVE} toBps={aaveBps} />
          <WeightBar label="USDY" fromBps={cur.USDY} toBps={usdyBps} />
          <WeightBar label="AUSD" fromBps={cur.AUSD} toBps={ausdBps} />
        </div>
        <hr className="cs-divider" />
        <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">TVL</span><span className="v mono">${vault.tvlUsdc}</span></div>
        <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">Total move</span><span className="v mono">{pctStr(plan.moveBps)}%</span></div>
        {needsSwap && <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">Swap legs</span><span className="v mono">{plan.legs.map((l) => `${l.side === "deposit" ? "+" : "−"}${l.bucket}`).join(", ")}</span></div>}
      </Card>

      <Card>
        <div className="cs-card-hl">
          <span className="cs-card-title" style={{ margin: 0 }}><Icon name="lock" size={14} />Guardrails enforced</span>
          <span className="chip role-success" style={{ height: 22 }}><Icon name="shield-check" size={12} />on-chain</span>
        </div>
        <GuardrailFacts />
      </Card>
    </>
  );
}

export function AllocatorPage({ loading, onToast }: { loading: boolean; onToast?: ((t: ToastPayload) => void) | undefined }) {
  const { address } = useAccount();
  const { isAllocator, isLive } = useAllocator(address);

  if (loading) {
    return <div className="page"><div className="grid agent-cols"><Skeleton h={360} r={14} /><Skeleton h={300} r={14} /></div></div>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Allocator</h1>
          <p className="page-sub">Manually set the vault's target allocation across all buckets in a single rebalance. Validated against the on-chain guardrails and simulated before signing.</p>
        </div>
      </div>
      {!isLive ? (
        <Card><p style={{ margin: 0, color: "var(--muted)" }}>No vault is deployed for this network.</p></Card>
      ) : !isAllocator ? (
        <Card>
          <span className="cs-card-title"><Icon name="lock" size={14} />Restricted</span>
          <p style={{ margin: 0, color: "var(--muted)" }}>This page is for the vault's ALLOCATOR. Connect the allocator wallet to manage the allocation.</p>
        </Card>
      ) : (
        <div className="grid agent-cols">
          <RebalanceForm onToast={onToast ?? (() => {})} />
        </div>
      )}
    </div>
  );
}
