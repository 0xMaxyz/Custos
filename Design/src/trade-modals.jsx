/* Deposit / Withdraw / Tx status modals (§6). Exported to window. */
(function () {
  const { useState } = React;
  const Icon = window.Icon, f = window.fmt, S = window.CUSTOS;
  const Modal = window.Modal;

  const PER_TX_CAP = 10000, SHARE_PRICE = parseFloat(S.vault.sharePrice);

  function Stepper({ steps, current }) {
    return (
      <div className="stepper">
        {steps.map((s, i) => (
          <React.Fragment key={s}>
            <div className={"step" + (i < current ? " done" : i === current ? " active" : "")}>
              <span className="step-num">{i < current ? <Icon name="check" size={13} /> : i + 1}</span>{s}
            </div>
            {i < steps.length - 1 && <div className="step-line" />}
          </React.Fragment>
        ))}
      </div>
    );
  }

  function PreviewRow({ k, v, accent }) {
    return <div className="kvrow" style={{ padding: "6px 0" }}><span className="k">{k}</span><span className="v mono" style={{ fontSize: "0.875rem", color: accent }}>{v}</span></div>;
  }

  // ---------- Deposit ----------
  function DepositModal({ wallet, vault, onClose, onToast }) {
    const [amt, setAmt] = useState("");
    const [phase, setPhase] = useState("form"); // form | approving | approved | depositing | done | failed
    const bal = parseFloat(wallet.balance);
    const tvl = parseFloat(vault.tvlUsdc), cap = parseFloat(vault.tvlCapUsdc);
    const remaining = cap - tvl;
    const n = parseFloat(amt) || 0;
    const sharesOut = n / SHARE_PRICE;
    let err = null;
    if (n > bal) err = "Exceeds wallet balance";
    else if (n > PER_TX_CAP) err = `Over per-tx cap of ${f.usd(PER_TX_CAP, { cents: false })}`;
    else if (n > remaining) err = `Only ${f.usd(remaining, { cents: false })} of vault capacity left`;
    const valid = n > 0 && !err;
    const step = phase === "form" || phase === "approving" ? 0 : phase === "approved" || phase === "depositing" ? 1 : 1;

    const run = () => {
      setPhase("approving");
      setTimeout(() => { setPhase("approved"); setTimeout(() => {
        setPhase("depositing"); setTimeout(() => {
          setPhase("done"); onToast({ kind: "success", title: "Deposit confirmed", body: `${f.usd(n)} deposited · ${f.num(sharesOut)} shares`, tx: "0xabc9876543210fedcba9876543210fedcba9876543210fedcba98765432100abc" });
        }, 1200);
      }, 900); }, 1100);
    };

    if (phase === "done") return <TxResult kind="confirmed" title="Deposit confirmed" lines={[`You deposited ${f.usd(n)}`, `Received ${f.num(sharesOut)} shares`]} tx="0xabc9876543210fedcba9876543210fedcba9876543210fedcba98765432100abc" onClose={onClose} />;

    const busy = phase === "approving" || phase === "depositing";
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
            <span style={{ color: "var(--muted)" }}>Balance <span className="mono">{f.usd(bal)}</span></span>
            <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy}
              onClick={() => setAmt(String(Math.min(bal, PER_TX_CAP, remaining)))}>Max</button>
          </div>
        </div>

        {err && n > 0 && <div className="disclosure" style={{ marginTop: 12, color: "var(--error)", background: "var(--error-soft)" }}><Icon name="alert-triangle" size={15} />{err}</div>}

        <div style={{ marginTop: 16 }}>
          <PreviewRow k="Shares out" v={valid ? f.num(sharesOut) : "—"} />
          <PreviewRow k="Share price" v={f.price(SHARE_PRICE)} />
          <PreviewRow k="Projected blended APY" v={f.bpsToPct(vault.blendedApyBps)} accent="var(--success)" />
          <PreviewRow k="Vault capacity" v={`${f.usd(tvl, { cents: false })} / ${f.usd(cap, { cents: false })}`} />
        </div>

        <p className="disclosure" style={{ marginTop: 14 }}>
          <Icon name="shield" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          Funds are managed within immutable on-chain guardrails. Per-tx cap {f.usd(PER_TX_CAP, { cents: false })} · vault cap {f.usd(cap, { cents: false })}.
        </p>

        <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy} onClick={run}>
          {busy ? <><window.Spinner /> {phase === "approving" ? "Approving…" : "Depositing…"}</> : phase === "approved" ? "Confirm deposit" : valid ? "Approve & deposit" : "Enter an amount"}
        </button>
      </Modal>
    );
  }

  // ---------- Withdraw ----------
  function WithdrawModal({ position, vault, onClose, onToast }) {
    const [unit, setUnit] = useState("USDC"); // USDC | shares
    const [amt, setAmt] = useState("");
    const [phase, setPhase] = useState("form");
    const maxUsdc = parseFloat(position.valueUsdc), maxShares = parseFloat(position.shares);
    const instant = parseFloat(vault.instantWithdrawableUsdc);
    const n = parseFloat(amt) || 0;
    const usdcOut = unit === "USDC" ? n : n * SHARE_PRICE;
    const sharesIn = unit === "shares" ? n : n / SHARE_PRICE;
    const max = unit === "USDC" ? maxUsdc : maxShares;
    const overInstant = usdcOut > instant;
    const valid = n > 0 && n <= max + 0.001;

    const run = () => {
      setPhase("withdrawing");
      setTimeout(() => { setPhase("done"); onToast({ kind: "success", title: "Withdrawal confirmed", body: `${f.usd(usdcOut)} sent to your wallet`, tx: "0xdef1a2b3c4d5e6f7890123456789abcdef0123456789abcdef0123456789abcd" }); }, 1600);
    };
    if (phase === "done") return <TxResult kind="confirmed" title="Withdrawal confirmed" lines={[`You withdrew ${f.usd(usdcOut)}`, `Burned ${f.num(sharesIn)} shares`]} tx="0xdef1a2b3c4d5e6f7890123456789abcdef0123456789abcdef0123456789abcd" onClose={onClose} />;
    const busy = phase === "withdrawing";

    return (
      <Modal title="Withdraw" icon="minus" onClose={busy ? () => {} : onClose}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <div className="seg" role="tablist" aria-label="Withdraw unit">
            {["USDC", "shares"].map((u) => <button key={u} className={unit === u ? "on" : ""} onClick={() => { setUnit(u); setAmt(""); }} role="tab" aria-selected={unit === u}>{u}</button>)}
          </div>
        </div>
        <div className="amount-field">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input className="amount-input" inputMode="decimal" placeholder="0.00" value={amt} disabled={busy}
              onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={"Withdraw amount in " + unit} />
            <span style={{ fontWeight: 700, color: "var(--muted)" }}>{unit}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.8125rem" }}>
            <span style={{ color: "var(--muted)" }}>Position <span className="mono">{unit === "USDC" ? f.usd(maxUsdc) : f.num(maxShares)}</span></span>
            <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} disabled={busy} onClick={() => setAmt(String(max))}>Max</button>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <PreviewRow k={unit === "USDC" ? "Shares burned" : "USDC out"} v={valid ? (unit === "USDC" ? f.num(sharesIn) : f.usd(usdcOut)) : "—"} />
          <PreviewRow k="Share price" v={f.price(SHARE_PRICE)} />
        </div>
        <p className="disclosure" style={{ marginTop: 14, color: overInstant ? "var(--warning)" : undefined, background: overInstant ? "var(--warning-soft)" : undefined }}>
          <Icon name={overInstant ? "alert-triangle" : "droplet"} size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          {overInstant
            ? `Large withdrawal — exceeds ${f.usd(instant, { cents: false })} instant liquidity, so part may unwind USDY with up to 0.5% slippage.`
            : `Served from instant liquidity (${f.usd(instant, { cents: false })} available).`}
        </p>
        <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }} disabled={!valid || busy} onClick={run}>
          {busy ? <><window.Spinner />Withdrawing…</> : valid ? "Withdraw" : "Enter an amount"}
        </button>
      </Modal>
    );
  }

  // ---------- Tx result panel ----------
  function TxResult({ kind, title, lines, tx, onClose }) {
    const ok = kind === "confirmed";
    return (
      <Modal title={title} icon={ok ? "check-circle" : "alert-triangle"} onClose={onClose}>
        <div style={{ textAlign: "center", padding: "6px 0 4px" }}>
          <div className="tx-icon" style={{ background: ok ? "var(--success-soft)" : "var(--error-soft)", color: ok ? "var(--success)" : "var(--error)" }}>
            <Icon name={ok ? "check" : "x"} size={30} />
          </div>
          {lines.map((l, i) => <div key={i} style={{ fontSize: i === 0 ? "1.0625rem" : "0.9375rem", fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "var(--base-content)" : "var(--muted)", marginTop: i ? 4 : 0 }}>{l}</div>)}
          <div style={{ marginTop: 16 }}>
            <a className="linklike" href={S.explorer + "/tx/" + tx} target="_blank" rel="noreferrer" style={{ justifyContent: "center" }}>View on Mantlescan <Icon name="external-link" size={14} /></a>
          </div>
        </div>
        <button className="btn btn-ghost btn-block" style={{ marginTop: 16 }} onClick={onClose}>Done</button>
      </Modal>
    );
  }

  Object.assign(window, { DepositModal, WithdrawModal });
})();
