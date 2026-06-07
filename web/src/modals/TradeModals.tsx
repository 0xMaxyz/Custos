// Deposit / Withdraw / Tx status. Matches Design/src/trade-modals.jsx.
//
// The vault is resolved for the connected chain via resolveDeployment() (the
// committed @custos/shared address, or a VITE_VAULT_ADDRESS override). When a
// vault resolves (isDeployed), drives real on-chain writes:
//   Deposit:  USDC.approve(vault, amount) → vault.deposit(amount, receiver)
//   Withdraw: vault.redeem(shares, receiver, owner)  (no approve needed)
// Otherwise (no deploy for the chain, or VITE_DEMO_MODE) drives the simulated flow.

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parseUnits } from "viem";
import { Icon } from "../components/Icons";
import { Spinner } from "../components/Components";
import { Modal } from "./Modals";
import * as fmt from "../lib/fmt";
import { explorer, type VaultState, type PositionState } from "../lib/data";
import { resolveDeployment } from "../lib/deployment";
import { ERC20_APPROVE_ABI, VAULT_ABI } from "../lib/vaultAbi";
import {
  previewDeposit,
  depositStepIndex,
  isDepositBusy,
  nextDepositPhase,
  previewWithdraw,
  isWithdrawBusy,
  PER_TX_DEPOSIT_CAP as PER_TX_CAP,
  type DepositPhase,
  type WithdrawPhase,
  type WithdrawUnit,
} from "../lib/txMachine";

// Minimal wallet shape the trade modals need (address + spendable USDC balance).
export interface TradeWallet { connected: boolean; address?: string | undefined; balance?: string | undefined; }

// After a deposit/redeem mines, vault balances change on-chain. Invalidate the
// wagmi read queries so useVaultData refetches immediately instead of lagging up to
// its 15s poll (which can look like a duplicate/no-op action) (N6). wagmi keys read
// hooks as ['readContract', …] / ['readContracts', …]; react-query prefix-matches.
function invalidateVaultReads(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["readContracts"] });
  void qc.invalidateQueries({ queryKey: ["readContract"] });
}

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div key={s} style={{ display: "contents" }}>
          <div className={"step" + (i < current ? " done" : i === current ? " active" : "")}>
            <span className="step-num">{i < current ? <Icon name="check" size={13} /> : i + 1}</span>{s}
          </div>
          {i < steps.length - 1 && <div className="step-line" />}
        </div>
      ))}
    </div>
  );
}

function PreviewRow({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return <div className="kvrow" style={{ padding: "6px 0" }}><span className="k">{k}</span><span className="v mono" style={{ fontSize: "0.875rem", color: accent }}>{v}</span></div>;
}

function TxResult({ kind, title, lines, tx, onClose }: { kind: "confirmed" | "failed"; title: string; lines: string[]; tx: string; onClose: () => void }) {
  const ok = kind === "confirmed";
  return (
    <Modal title={title} icon={ok ? "check-circle" : "alert-triangle"} onClose={onClose}>
      <div style={{ textAlign: "center", padding: "6px 0 4px" }}>
        <div className="tx-icon" style={{ background: ok ? "var(--success-soft)" : "var(--error-soft)", color: ok ? "var(--success)" : "var(--error)" }}>
          <Icon name={ok ? "check" : "x"} size={30} />
        </div>
        {lines.map((l, i) => <div key={i} style={{ fontSize: i === 0 ? "1.0625rem" : "0.9375rem", fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "var(--base-content)" : "var(--muted)", marginTop: i ? 4 : 0 }}>{l}</div>)}
        {tx && <div style={{ marginTop: 16 }}>
          <a className="linklike" href={explorer + "/tx/" + tx} target="_blank" rel="noreferrer" style={{ justifyContent: "center" }}>View on Mantlescan <Icon name="external-link" size={14} /></a>
        </div>}
      </div>
      <button className="btn btn-ghost btn-block" style={{ marginTop: 16 }} onClick={onClose}>Done</button>
    </Modal>
  );
}

// ---------- Deposit ----------
export function DepositModal({ wallet, vault, usdcAddress, onClose, onToast }: {
  wallet: TradeWallet;
  vault: VaultState;
  usdcAddress: `0x${string}` | "";
  onClose: () => void;
  onToast: (t: ToastPayload) => void;
}) {
  const [amt, setAmt] = useState("");
  const [phase, setPhase] = useState<DepositPhase>("form");
  const [approveHash, setApproveHash] = useState("");
  const [txHash, setTxHash] = useState("");
  const { address: userAddress } = useAccount();
  const queryClient = useQueryClient();
  // Writes target the connected chain's deployed vault (resolved from @custos/shared).
  const VAULT_ADDRESS = resolveDeployment(useChainId()).vault as `0x${string}`;
  const isDeployed = VAULT_ADDRESS.length > 2;
  const sharePrice = parseFloat(vault.sharePrice);
  const bal = parseFloat(wallet.balance ?? "0");
  const tvl = parseFloat(vault.tvlUsdc), cap = parseFloat(vault.tvlCapUsdc);

  const p = previewDeposit({ amount: amt, walletBalance: bal, tvl, tvlCap: cap, sharePrice });
  const { amount: n, sharesOut, error: err, valid } = p;
  const step = depositStepIndex(phase);

  // Wagmi write hooks (only used when isDeployed).
  const depositAfterApprove = useRef(false);
  const { writeContractAsync: writeApprove } = useWriteContract();
  const { writeContractAsync: writeDeposit  } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash ? (approveHash as `0x${string}`) : undefined,
    query: { enabled: isDeployed && approveHash.length > 2 },
  });
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: txHash ? (txHash as `0x${string}`) : undefined,
    query: { enabled: isDeployed && txHash.length > 2 },
  });

  // After approve mines, submit deposit (do not send both txs back-to-back).
  useEffect(() => {
    if (!approveConfirmed || phase !== "approved" || !userAddress || !isDeployed || depositAfterApprove.current) {
      return;
    }
    depositAfterApprove.current = true;
    const assets = parseUnits(String(n), 6);
    setPhase("depositing");
    void writeDeposit({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "deposit", args: [assets, userAddress] })
      .then((hash) => setTxHash(hash))
      .catch(() => {
        depositAfterApprove.current = false;
        setPhase("form");
        setApproveHash("");
        onToast({ kind: "error", title: "Deposit failed", body: "Approve succeeded but deposit reverted — try again." });
      });
  }, [approveConfirmed, phase, userAddress, isDeployed, n, writeDeposit, onToast]);

  useEffect(() => {
    if (depositConfirmed && phase === "depositing") {
      setPhase("done");
      invalidateVaultReads(queryClient); // refresh TVL/position now, not on the next poll (N6)
      onToast({ kind: "success", title: "Deposit confirmed", body: `${fmt.usd(n)} deposited · ${fmt.num(sharesOut)} shares`, tx: txHash });
    }
  }, [depositConfirmed, phase, n, sharesOut, txHash, onToast, queryClient]);

  const runLive = async () => {
    if (!userAddress || !usdcAddress) return;
    try {
      const assets = parseUnits(String(n), 6);
      depositAfterApprove.current = false;
      setApproveHash("");
      setTxHash("");
      setPhase("approving");
      const hash = await writeApprove({ address: usdcAddress, abi: ERC20_APPROVE_ABI, functionName: "approve", args: [VAULT_ADDRESS, assets] });
      setApproveHash(hash);
      setPhase("approved");
    } catch {
      setPhase("form");
      setApproveHash("");
      onToast({ kind: "error", title: "Transaction failed", body: "Check your wallet and try again." });
    }
  };

  const runSimulated = () => {
    setPhase("approving");
    setTimeout(() => { setPhase((x) => nextDepositPhase(x)); setTimeout(() => {
      setPhase("depositing"); setTimeout(() => {
        setPhase((x) => nextDepositPhase(x));
        onToast({ kind: "success", title: "Deposit confirmed (preview)", body: `${fmt.usd(n)} deposited · ${fmt.num(sharesOut)} shares` });
      }, 1200);
    }, 900); }, 1100);
  };

  const run = () => { if (isDeployed && usdcAddress) { void runLive(); } else { runSimulated(); } };

  if (phase === "done") return <TxResult kind="confirmed" title="Deposit confirmed" lines={[`You deposited ${fmt.usd(n)}`, `Received ${fmt.num(sharesOut)} shares`]} tx={txHash} onClose={onClose} />;

  const busy = isDepositBusy(phase);
  return (
    <Modal title="Deposit USDC" icon="plus" onClose={busy ? () => {} : onClose}>
      <Stepper steps={["Approve", "Deposit"]} current={step} />
      <div className="amount-field">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input className="amount-input" inputMode="decimal" placeholder="0.00" value={amt} disabled={busy}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Deposit amount in USDC" />
          <span style={{ fontWeight: 700, color: "var(--muted)" }}>USDC</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.8125rem" }}>
          <span style={{ color: "var(--muted)" }}>Balance <span className="mono">{fmt.usd(bal)}</span></span>
          <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy}
            onClick={() => setAmt(String(p.maxDepositable))}>Max</button>
        </div>
      </div>
      {err && n > 0 && <div className="disclosure" style={{ marginTop: 12, color: "var(--error)", background: "var(--error-soft)" }}><Icon name="alert-triangle" size={15} />{err}</div>}
      <div style={{ marginTop: 16 }}>
        <PreviewRow k="Shares out" v={valid ? fmt.num(sharesOut) : "—"} />
        <PreviewRow k="Share price" v={fmt.price(sharePrice)} />
        <PreviewRow k="Projected blended APY" v={fmt.bpsToPct(vault.blendedApyBps)} accent="var(--success)" />
        <PreviewRow k="Vault capacity" v={`${fmt.usd(tvl, { cents: false })} / ${fmt.usd(cap, { cents: false })}`} />
      </div>
      <p className="disclosure" style={{ marginTop: 14 }}>
        <Icon name="shield" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        Funds are managed within immutable on-chain guardrails. Per-tx cap {fmt.usd(PER_TX_CAP, { cents: false })} · vault cap {fmt.usd(cap, { cents: false })}.
      </p>
      {isDeployed && !usdcAddress && (
        <p className="disclosure" style={{ marginTop: 8, color: "var(--warning)" }}>
          <Icon name="alert-triangle" size={15} style={{ flexShrink: 0 }} />
          Resolving token address… please wait a moment.
        </p>
      )}
      <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy || (isDeployed && !usdcAddress)} onClick={run}>
        {busy ? <><Spinner /> {phase === "approving" ? "Approving…" : "Depositing…"}</> : phase === "approved" ? "Confirm deposit" : valid ? "Approve & deposit" : "Enter an amount"}
      </button>
    </Modal>
  );
}

// ---------- Withdraw ----------
export function WithdrawModal({ position, vault, onClose, onToast }: {
  position: PositionState;
  vault: VaultState;
  onClose: () => void;
  onToast: (t: ToastPayload) => void;
}) {
  const [unit, setUnit] = useState<WithdrawUnit>("USDC");
  const [amt, setAmt] = useState("");
  const [phase, setPhase] = useState<WithdrawPhase>("form");
  const [txHash, setTxHash] = useState("");
  const { address: userAddress } = useAccount();
  const queryClient = useQueryClient();
  const VAULT_ADDRESS = resolveDeployment(useChainId()).vault as `0x${string}`;
  const isDeployed = VAULT_ADDRESS.length > 2;
  const sharePrice = parseFloat(vault.sharePrice);
  const instant = parseFloat(vault.instantWithdrawableUsdc);

  const p = previewWithdraw({
    amount: amt,
    unit,
    positionUsdc: parseFloat(position.valueUsdc),
    positionShares: parseFloat(position.shares),
    instantUsdc: instant,
    sharePrice,
  });
  const { usdcOut, sharesIn, max, exceedsInstant: overInstant, valid } = p;

  const { writeContractAsync: writeRedeem } = useWriteContract();
  const { isSuccess: redeemConfirmed } = useWaitForTransactionReceipt({
    hash: txHash ? (txHash as `0x${string}`) : undefined,
    query: { enabled: isDeployed && txHash.length > 2 },
  });

  useEffect(() => {
    if (redeemConfirmed && phase === "withdrawing") {
      setPhase("done");
      invalidateVaultReads(queryClient); // refresh TVL/position now, not on the next poll (N6)
      onToast({ kind: "success", title: "Withdrawal confirmed", body: `${fmt.usd(usdcOut)} sent to your wallet`, tx: txHash });
    }
  }, [redeemConfirmed]);

  const runLive = async () => {
    if (!userAddress) return;
    try {
      setPhase("withdrawing");
      const shares = parseUnits(String(sharesIn), 6);
      const hash = await writeRedeem({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "redeem", args: [shares, userAddress, userAddress] });
      setTxHash(hash);
    } catch {
      setPhase("form");
      onToast({ kind: "error", title: "Transaction failed", body: "Check your wallet and try again." });
    }
  };

  const runSimulated = () => {
    setPhase("withdrawing");
    setTimeout(() => {
      setPhase("done");
      onToast({ kind: "success", title: "Withdrawal confirmed (preview)", body: `${fmt.usd(usdcOut)} sent to your wallet` });
    }, 1600);
  };

  const run = () => { if (isDeployed) { void runLive(); } else { runSimulated(); } };

  if (phase === "done") return <TxResult kind="confirmed" title="Withdrawal confirmed" lines={[`You withdrew ${fmt.usd(usdcOut)}`, `Burned ${fmt.num(sharesIn)} shares`]} tx={txHash} onClose={onClose} />;
  const busy = isWithdrawBusy(phase);

  return (
    <Modal title="Withdraw" icon="minus" onClose={busy ? () => {} : onClose}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <div className="seg" role="tablist" aria-label="Withdraw unit">
          {(["USDC", "shares"] as const).map((u) => <button key={u} className={unit === u ? "on" : ""} onClick={() => { setUnit(u); setAmt(""); }} role="tab" aria-selected={unit === u}>{u}</button>)}
        </div>
      </div>
      <div className="amount-field">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input className="amount-input" inputMode="decimal" placeholder="0.00" value={amt} disabled={busy}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={"Withdraw amount in " + unit} />
          <span style={{ fontWeight: 700, color: "var(--muted)" }}>{unit}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.8125rem" }}>
          <span style={{ color: "var(--muted)" }}>Position <span className="mono">{unit === "USDC" ? fmt.usd(max) : fmt.num(max)}</span></span>
          <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy} onClick={() => setAmt(String(max))}>Max</button>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <PreviewRow k={unit === "USDC" ? "Shares burned" : "USDC out"} v={valid ? (unit === "USDC" ? fmt.num(sharesIn) : fmt.usd(usdcOut)) : "—"} />
        <PreviewRow k="Share price" v={fmt.price(sharePrice)} />
      </div>
      <p className="disclosure" style={{ marginTop: 14, color: overInstant ? "var(--warning)" : undefined, background: overInstant ? "var(--warning-soft)" : undefined }}>
        <Icon name={overInstant ? "alert-triangle" : "droplet"} size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        {overInstant
          ? `Large withdrawal — exceeds ${fmt.usd(instant, { cents: false })} instant liquidity, so part may unwind USDY with up to 0.5% slippage.`
          : `Served from instant liquidity (${fmt.usd(instant, { cents: false })} available).`}
      </p>
      <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy} onClick={run}>
        {busy ? <><Spinner />Withdrawing…</> : valid ? "Withdraw" : "Enter an amount"}
      </button>
    </Modal>
  );
}

export interface ToastPayload { kind: "success" | "error" | "info"; title: string; body?: string; tx?: string; }
