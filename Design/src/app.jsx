/* App controller: routing, theme/network/wallet state, modal host, toasts. */
(function () {
  const { useState, useEffect, useCallback } = React;
  const Icon = window.Icon, f = window.fmt, S = window.SENTINEL;

  const ROUTES = ["dashboard", "activity", "agent", "insights"];
  const MOCK_WALLET = { address: "0xA11c3b9D7e2F4a8c6B0d1E5f9A3c7B2d4E6f8A0E", balance: S.walletUsdcBalance, connector: "MetaMask" };

  function useHashRoute() {
    const get = () => { const h = (location.hash || "").replace("#", ""); return ROUTES.includes(h) ? h : "dashboard"; };
    const [route, setRoute] = useState(get);
    useEffect(() => { const on = () => setRoute(get()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
    const go = useCallback((r) => { location.hash = r; setRoute(r); window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" }); }, []);
    return [route, go];
  }

  function Toasts({ items, dismiss }) {
    return (
      <div className="toast-wrap" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={"toast " + (t.kind || "info")} role="status">
            <Icon name={t.kind === "success" ? "check-circle" : t.kind === "error" ? "alert-triangle" : "info"} size={17}
              style={{ color: `var(--${t.kind === "success" ? "success" : t.kind === "error" ? "error" : "info"})`, flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{t.title}</div>
              {t.body && <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 2 }}>{t.body}</div>}
              {t.tx && <a className="linklike" style={{ fontSize: "0.75rem", marginTop: 4 }} href={S.explorer + "/tx/" + t.tx} target="_blank" rel="noreferrer">Mantlescan <Icon name="external-link" size={12} /></a>}
            </div>
            <button className="iconbtn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    );
  }

  function App() {
    const [theme, setThemeState] = useState(() => localStorage.getItem("sentinel-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "sentinel-dark" : "sentinel-light"));
    const [net, setNet] = useState("mainnet");
    const [wallet, setWallet] = useState({ connected: false });
    const [route, go] = useHashRoute();
    const [modal, setModal] = useState(null); // {type, data}
    const [toasts, setToasts] = useState([]);
    const [loading, setLoading] = useState(true);

    // env flags (demoable states) — persisted so verifier/user can flip
    const [flags, setFlags] = useState(() => ({ paused: S.vault.paused, killed: S.vault.killed, wrongNet: false, emptyPosition: false, activityError: false }));

    useEffect(() => {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("sentinel-theme", theme);
    }, [theme]);
    const setTheme = (t) => setThemeState(t);

    useEffect(() => { const id = setTimeout(() => setLoading(false), 650); return () => clearTimeout(id); }, []);

    const pushToast = useCallback((t) => {
      const id = Date.now() + Math.random();
      setToasts((arr) => [...arr, { id, ...t }]);
      setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== id)), 6000);
    }, []);
    const dismiss = (id) => setToasts((arr) => arr.filter((x) => x.id !== id));

    const connect = (connector) => {
      setWallet({ connected: true, ...MOCK_WALLET, connector: connector ? connector.name : "MetaMask" });
      setModal(null);
      pushToast({ kind: "success", title: "Wallet connected", body: f.shortAddr(MOCK_WALLET.address, 6, 4) });
    };
    const disconnect = () => { setWallet({ connected: false }); pushToast({ kind: "info", title: "Wallet disconnected" }); };

    const needWallet = (next) => { if (!wallet.connected) { setModal({ type: "connect" }); } else { next(); } };

    const props = {
      connected: wallet.connected, paused: flags.paused, killed: flags.killed, emptyPosition: flags.emptyPosition, activityError: flags.activityError, go, loading,
      onConnect: () => setModal({ type: "connect" }),
      onDeposit: () => needWallet(() => setModal({ type: "deposit" })),
      onWithdraw: () => needWallet(() => setModal({ type: "withdraw" })),
      onToast: pushToast,
      openDecision: (d) => setModal({ type: "decision", data: d }),
    };

    let Page = null;
    if (route === "dashboard") Page = <window.DashboardPage {...props} />;
    else if (route === "activity") Page = <window.ActivityPage {...props} />;
    else if (route === "agent") Page = <window.AgentPage {...props} />;
    else if (route === "insights") Page = <window.InsightsPage {...props} />;

    return (
      <div className="app-root" data-theme={theme}>
        <window.Topbar route={route} go={go} theme={theme} setTheme={setTheme} net={net}
          onSwitchNet={() => setModal({ type: "network" })} wallet={wallet}
          onConnect={() => setModal({ type: "connect" })} onManage={() => setModal({ type: "account" })} />
        <window.Banners wrongNet={flags.wrongNet && wallet.connected} paused={flags.paused} killed={flags.killed} onSwitch={() => setModal({ type: "network" })} />
        <main>{Page}</main>
        <window.Footer />
        <window.MobileNav route={route} go={go} />

        {modal && modal.type === "connect" && <window.ConnectModal onClose={() => setModal(null)} onConnect={connect} />}
        {modal && modal.type === "network" && <window.NetworkSwitchModal net={net} onClose={() => setModal(null)} onSwitch={setNet} />}
        {modal && modal.type === "account" && <window.AccountModal wallet={wallet} net={net} onClose={() => setModal(null)} onDisconnect={disconnect} onSwitchNet={() => setModal({ type: "network" })} />}
        {modal && modal.type === "deposit" && <window.DepositModal wallet={wallet} vault={S.vault} onClose={() => setModal(null)} onToast={pushToast} />}
        {modal && modal.type === "withdraw" && <window.WithdrawModal position={S.position} vault={S.vault} onClose={() => setModal(null)} onToast={pushToast} />}
        {modal && modal.type === "decision" && <window.DecisionDetailModal decision={modal.data} onClose={() => setModal(null)} />}

        <Toasts items={toasts} dismiss={dismiss} />
        <window.DevFlags flags={flags} setFlags={setFlags} />
      </div>
    );
  }

  window.SentinelApp = App;
})();
