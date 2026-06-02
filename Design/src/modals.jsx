/* Modals (§6): Modal shell, Connect, Deposit, Withdraw, TxStatus, NetworkSwitch, Account. Exported to window. */
(function () {
  const { useState, useEffect, useRef } = React;
  const Icon = window.Icon, f = window.fmt, S = window.CUSTOS;

  // ---------- Modal shell: focus-trap, Esc, scroll-lock, aria ----------
  function Modal({ title, icon, onClose, children, footer, size }) {
    const ref = useRef(null);
    useEffect(() => {
      const prev = document.activeElement;
      document.body.style.overflow = "hidden";
      const el = ref.current;
      const focusables = () => el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const first = focusables()[0]; first && first.focus();
      const onKey = (e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const fs = focusables(); if (!fs.length) return;
          const a = fs[0], z = fs[fs.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
          else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey);
      return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; prev && prev.focus && prev.focus(); };
    }, []);
    return (
      <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={"modal" + (size === "lg" ? " modal-lg" : "")} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
          <div className="modal-head">
            {icon && <span className="brand-mark" style={{ width: 30, height: 30, background: "var(--primary-soft)", color: "var(--primary)" }}><Icon name={icon} size={17} /></span>}
            <h2 className="modal-title">{title}</h2>
            <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    );
  }

  // ---------- Connect wallet (mock RainbowKit) ----------
  const CONNECTORS = [
    { id: "mm", name: "MetaMask", color: "#f6851b", letter: "M" },
    { id: "rabby", name: "Rabby", color: "#7084ff", letter: "R" },
    { id: "wc", name: "WalletConnect", color: "#3b99fc", letter: "W" },
    { id: "cb", name: "Coinbase Wallet", color: "#0052ff", letter: "C" },
  ];
  function ConnectModal({ onClose, onConnect }) {
    return (
      <Modal title="Connect a wallet" icon="wallet" onClose={onClose}>
        <div className="wallet-list">
          {CONNECTORS.map((c) => (
            <button key={c.id} className="wallet-row" onClick={() => onConnect(c)}>
              <span className="wallet-ic" style={{ background: c.color }}>{c.letter}</span>
              <span style={{ flex: 1 }}>{c.name}</span>
              <Icon name="chevron-right" size={16} style={{ color: "var(--faint)" }} />
            </button>
          ))}
        </div>
        <p className="disclosure" style={{ marginTop: 14 }}>
          <Icon name="info" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          By connecting you agree this is an experimental vault on Mantle. Only deposit funds you can afford to lock.
        </p>
      </Modal>
    );
  }

  // ---------- Network switch ----------
  function NetworkSwitchModal({ net, onClose, onSwitch }) {
    return (
      <Modal title="Switch network" icon="refresh-cw" onClose={onClose}>
        <div className="wallet-list">
          {["mainnet", "testnet"].map((k) => (
            <button key={k} className="wallet-row" onClick={() => { onSwitch(k); onClose(); }}
              style={net === k ? { borderColor: "var(--primary)", background: "var(--primary-soft)" } : {}}>
              <span className="dot" style={{ background: k === "testnet" ? "var(--warning)" : "var(--success)", width: 10, height: 10 }} />
              <span style={{ flex: 1 }}>{S.chains[k].label}<span style={{ color: "var(--faint)", fontWeight: 500, marginLeft: 6 }} className="mono">{S.chains[k].id}</span></span>
              {net === k && <Icon name="check" size={16} style={{ color: "var(--primary)" }} />}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  // ---------- Account (manage) ----------
  function AccountModal({ wallet, net, onClose, onDisconnect, onSwitchNet }) {
    return (
      <Modal title="Account" icon="wallet" onClose={onClose}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span className="avatar" style={{ width: 44, height: 44, borderRadius: 12 }} />
          <div>
            <div className="mono" style={{ fontWeight: 600, fontSize: "1rem" }}>{f.shortAddr(wallet.address, 6, 4)}</div>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{wallet.connector} · {S.chains[net].label}</div>
          </div>
          <span style={{ flex: 1 }} />
          <window.CopyButton text={wallet.address} />
        </div>
        <div className="kvrow"><span className="k">USDC balance</span><span className="v mono">{f.usd(wallet.balance)}</span></div>
        <div className="kvrow"><span className="k">Network</span><span className="v">{S.chains[net].label} <span className="mono" style={{ color: "var(--faint)" }}>{S.chains[net].id}</span></span></div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost btn-block" onClick={() => { onSwitchNet(); onClose(); }}><Icon name="refresh-cw" size={15} />Switch network</button>
          <button className="btn btn-ghost btn-block" onClick={() => { onDisconnect(); onClose(); }}>Disconnect</button>
        </div>
      </Modal>
    );
  }

  window.Modal = Modal;
  Object.assign(window, { ConnectModal, NetworkSwitchModal, AccountModal });
})();
