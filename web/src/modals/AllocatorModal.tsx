// Allocator manual rebalance (Agent page, ALLOCATOR-gated).
//
// The autonomous agent only maintains/reduces the RWA position — it never grows an
// allocation from idle, so a fresh deposit sits as idle USDC until an ALLOCATOR seeds
// a target. This modal is that manual seed. A single action moves one bucket at a time:
//   • Aave  — no swap (swapData empty).
//   • USDY / AUSD — needs 1delta calldata for swapData[bucket]. The browser never holds
//     the 1delta key: it fetches the route from the agent's /swap/quote (which asserts the
//     pinned router server-side). The vault's adapter still enforces the on-chain minOut.

import { useState, useEffect, type ReactNode } from "react";
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, formatUnits, keccak256, toBytes } from "viem";
import {
  Bucket,
  MAX_WEIGHT_BPS,
  MAX_USDY_NOTIONAL_USDC,
  MIN_IDLE_BPS,
  MIN_INSTANT_LIQUIDITY_BPS,
  MIN_REBALANCE_INTERVAL,
} from "@custos/shared";
import { Icon } from "../components/Icons";
import { Spinner } from "../components/Components";
import { Modal } from "./Modals";
import * as fmt from "../lib/fmt";
import type { VaultState } from "../lib/data";
import { resolveDeployment } from "../lib/deployment";
import { VAULT_ABI } from "../lib/vaultAbi";
import { fetchSwapQuote, swapQuoteAvailable, type SwapBucket } from "../lib/swapQuote";
import type { ToastPayload } from "./TradeModals";

type BucketKey = "AAVE" | "USDY" | "AUSD";
type Direction = "deposit" | "withdraw";

const BUCKETS: Record<BucketKey, { idx: 1 | 2 | 3; enumVal: Bucket; needsSwap: boolean; label: string }> = {
  AAVE: { idx: 1, enumVal: Bucket.AAVE, needsSwap: false, label: "Aave" },
  USDY: { idx: 2, enumVal: Bucket.USDY, needsSwap: true, label: "USDY" },
  AUSD: { idx: 3, enumVal: Bucket.AUSD, needsSwap: true, label: "AUSD" },
};

const EMPTY_SLOT = "0x" as const;

function PreviewRow({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div className="kvrow" style={{ padding: "6px 0" }}>
      <span className="k">{k}</span>
      <span className="v mono" style={{ fontSize: "0.875rem", color: accent }}>{v}</span>
    </div>
  );
}

function WeightRow({ label, fromBps, toBps }: { label: string; fromBps: number; toBps: number }) {
  const changed = fromBps !== toBps;
  return (
    <div className="kvrow" style={{ padding: "5px 0" }}>
      <span className="k">{label}</span>
      <span className="v mono" style={{ fontSize: "0.8125rem" }}>
        <span style={{ color: "var(--muted)" }}>{(fromBps / 100).toFixed(1)}%</span>
        {changed && <> → <span style={{ color: "var(--base-content)", fontWeight: 600 }}>{(toBps / 100).toFixed(1)}%</span></>}
      </span>
    </div>
  );
}

export function AllocatorRebalanceModal({ vault, lastRebalanceAt, onClose, onToast }: {
  vault: VaultState;
  lastRebalanceAt: number;
  onClose: () => void;
  onToast: (t: ToastPayload) => void;
}) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const VAULT_ADDRESS = resolveDeployment(useChainId()).vault as `0x${string}`;

  const [bucket, setBucket] = useState<BucketKey>("AAVE");
  const [dir, setDir] = useState<Direction>("deposit");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [txHash, setTxHash] = useState("");

  const meta = BUCKETS[bucket];
  const cur = vault.weightsBps; // { IDLE, AAVE, USDY, AUSD } in bps
  const tvlRaw = (() => { try { return parseUnits(vault.tvlUsdc || "0", 6); } catch { return 0n; } })();
  const amountRaw = (() => { try { return amt ? parseUnits(amt, 6) : 0n; } catch { return 0n; } })();
  const deltaBps = tvlRaw > 0n ? Number((amountRaw * 10_000n) / tvlRaw) : 0;

  // Target weights: move `deltaBps` between IDLE and the chosen bucket; idle absorbs the rest.
  const curBucketBps = cur[bucket];
  const newBucketBps = dir === "deposit" ? curBucketBps + deltaBps : curBucketBps - deltaBps;
  const others = (["AAVE", "USDY", "AUSD"] as const).reduce((s, k) => s + (k === bucket ? newBucketBps : cur[k]), 0);
  const idleBps = 10_000 - others;
  const target: [number, number, number, number] = [
    idleBps,
    bucket === "AAVE" ? newBucketBps : cur.AAVE,
    bucket === "USDY" ? newBucketBps : cur.USDY,
    bucket === "AUSD" ? newBucketBps : cur.AUSD,
  ];

  const bucketCap = MAX_WEIGHT_BPS[meta.enumVal];
  // Max USDC the action can move (mirrors the guardrails so the tx won't revert).
  const maxRaw = (() => {
    if (tvlRaw <= 0n) return 0n;
    if (dir === "withdraw") return (BigInt(curBucketBps) * tvlRaw) / 10_000n;
    // deposit: bounded by idle (leaving the min buffer) and the bucket cap.
    const byIdle = (BigInt(Math.max(0, cur.IDLE - MIN_IDLE_BPS)) * tvlRaw) / 10_000n;
    const byCap = (BigInt(Math.max(0, bucketCap - curBucketBps)) * tvlRaw) / 10_000n;
    let m = byIdle < byCap ? byIdle : byCap;
    if (bucket === "USDY" && MAX_USDY_NOTIONAL_USDC > 0) {
      const curUsdyNotional = (BigInt(curBucketBps) * tvlRaw) / 10_000n;
      const room = BigInt(MAX_USDY_NOTIONAL_USDC) - curUsdyNotional;
      if (room < m) m = room > 0n ? room : 0n;
    }
    return m;
  })();

  // Interval guardrail.
  const now = Math.floor(Date.now() / 1000);
  const sinceLast = lastRebalanceAt > 0 ? now - lastRebalanceAt : Number.MAX_SAFE_INTEGER;
  const waitSecs = Math.max(0, MIN_REBALANCE_INTERVAL - sinceLast);

  const instantBps = idleBps + target[1]; // idle + Aave (the synchronously-liquid buckets)
  const swapUnavailable = meta.needsSwap && !swapQuoteAvailable;

  let error = "";
  if (tvlRaw <= 0n) error = "Vault is empty — deposit USDC first";
  else if (amountRaw <= 0n) error = "";
  else if (deltaBps <= 0) error = "Amount too small relative to TVL";
  else if (amountRaw > maxRaw) error = `Max ${fmt.usd(parseFloat(formatUnits(maxRaw, 6)))} for this move`;
  else if (newBucketBps > bucketCap) error = `${meta.label} capped at ${(bucketCap / 100).toFixed(0)}%`;
  else if (idleBps < MIN_IDLE_BPS) error = `Idle must stay at least ${(MIN_IDLE_BPS / 100).toFixed(0)}%`;
  else if (instantBps < MIN_INSTANT_LIQUIDITY_BPS) error = `Instant liquidity must stay above ${(MIN_INSTANT_LIQUIDITY_BPS / 100).toFixed(0)}%`;
  else if (waitSecs > 0) error = `Next rebalance in ${Math.ceil(waitSecs / 60)} min (1-hour guardrail)`;
  else if (swapUnavailable) error = "Agent API not configured — USDY/AUSD swaps unavailable";
  const valid = error === "" && amountRaw > 0n;

  const { writeContractAsync: writeRebalance } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({
    hash: txHash ? (txHash as `0x${string}`) : undefined,
    query: { enabled: txHash.length > 2 },
  });

  useEffect(() => {
    if (confirmed && busy) {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      void queryClient.invalidateQueries({ queryKey: ["readContract"] });
      onToast({
        kind: "success",
        title: "Rebalance confirmed",
        body: `${dir === "deposit" ? "Deployed" : "Withdrew"} ${fmt.usd(parseFloat(amt || "0"))} ${dir === "deposit" ? "into" : "from"} ${meta.label}`,
        tx: txHash,
      });
      onClose();
    }
  }, [confirmed]);

  const run = async () => {
    if (!valid || !address) return;
    try {
      // swapData: empty for every bucket except the swap-bearing one being moved.
      const swapData: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [EMPTY_SLOT, EMPTY_SLOT, EMPTY_SLOT, EMPTY_SLOT];
      let usdyDexSpot = 0n;

      if (meta.needsSwap) {
        setBusy(true);
        setBusyLabel("Fetching route…");
        const quote = await fetchSwapQuote({ bucket: bucket as SwapBucket, side: dir, usdcAmount: amountRaw.toString() });
        swapData[quote.bucketIndex] = quote.calldata;
        if (bucket === "USDY") usdyDexSpot = BigInt(quote.usdyDexSpotUsdc || "0");
      }

      setBusy(true);
      setBusyLabel("Rebalancing…");
      const decisionURI = `manual:web-allocator-${dir}-${bucket}`;
      const rationaleHash = keccak256(toBytes(decisionURI));
      const hash = await writeRebalance({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "rebalance",
        args: [target, swapData, decisionURI, rationaleHash, usdyDexSpot],
      });
      setTxHash(hash);
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : "Check your wallet and the guardrails, then try again.";
      onToast({ kind: "error", title: "Rebalance failed", body: msg });
    }
  };

  const seg = (opts: { value: string; label: string }[], active: string, onPick: (v: string) => void) => (
    <div className="seg" role="tablist">
      {opts.map((o) => (
        <button key={o.value} className={active === o.value ? "on" : ""} onClick={() => onPick(o.value)} role="tab" aria-selected={active === o.value} disabled={busy}>
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <Modal title="Allocator rebalance" icon="gauge" onClose={busy ? () => {} : onClose}>
      <p className="disclosure" style={{ marginTop: 0 }}>
        <Icon name="shield" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        Deploy idle USDC into a strategy (or pull it back). The agent only maintains or
        de-risks the position — it never grows an allocation from idle on its own.
      </p>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 14, flexWrap: "wrap" }}>
        {seg([{ value: "AAVE", label: "Aave" }, { value: "USDY", label: "USDY" }, { value: "AUSD", label: "AUSD" }], bucket, (v) => { setBucket(v as BucketKey); setAmt(""); })}
        {seg([{ value: "deposit", label: "Deploy" }, { value: "withdraw", label: "Withdraw" }], dir, (v) => { setDir(v as Direction); setAmt(""); })}
      </div>

      <div className="amount-field" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input className="amount-input" inputMode="decimal" placeholder="0.00" value={amt} disabled={busy}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Amount in USDC" />
          <span style={{ fontWeight: 700, color: "var(--muted)" }}>USDC</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.8125rem" }}>
          <span style={{ color: "var(--muted)" }}>{dir === "deposit" ? "Deploy into" : "Withdraw from"} {meta.label}</span>
          <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy}
            onClick={() => setAmt(formatUnits(maxRaw, 6))}>Max {fmt.usd(parseFloat(formatUnits(maxRaw, 6)))}</button>
        </div>
      </div>

      {error && amountRaw > 0n && (
        <div className="disclosure" style={{ marginTop: 12, color: "var(--error)", background: "var(--error-soft)" }}>
          <Icon name="alert-triangle" size={15} />{error}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <WeightRow label="Idle" fromBps={cur.IDLE} toBps={idleBps} />
        <WeightRow label="Aave" fromBps={cur.AAVE} toBps={target[1]} />
        <WeightRow label="USDY" fromBps={cur.USDY} toBps={target[2]} />
        <WeightRow label="AUSD" fromBps={cur.AUSD} toBps={target[3]} />
      </div>

      <div style={{ marginTop: 8 }}>
        <PreviewRow k="TVL" v={`$${vault.tvlUsdc}`} />
      </div>

      {meta.needsSwap && !swapUnavailable && (
        <p className="disclosure" style={{ marginTop: 12 }}>
          <Icon name="refresh-cw" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          Routed through 1delta via the agent (key stays server-side) against the pinned router,
          up to 0.5% slippage. The adapter enforces the on-chain minimum out.
        </p>
      )}

      <button className="cs-btn cs-btn-primary cs-btn-block cs-btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy} onClick={() => void run()}>
        {busy ? <><Spinner /> {busyLabel}</> : valid ? `${dir === "deposit" ? "Deploy into" : "Withdraw from"} ${meta.label}` : "Enter an amount"}
      </button>
    </Modal>
  );
}
