/* App shell components (§3, §4, §8). Exported to window. */
(function () {
  const { useState, useRef, useEffect } = React;
  const Icon = window.Icon;
  const f = window.fmt;
  const { chains } = window.SENTINEL;

  const NAV = [
    { route: "dashboard", label: "Dashboard", icon: "layout-dashboard" },
    { route: "activity", label: "Activity", icon: "scroll-text" },
    { route: "agent", label: "Agent", icon: "bot" },
    { route: "insights", label: "Insights", icon: "line-chart" },
  ];

  function Brand({ onClick }) {
    return (
      <a className="brand" href="#dashboard" onClick={onClick}>
        <span className="brand-mark"><Icon name="shield-check" size={18} /></span>
        Sentinel
      </a>
    );
  }

  function ThemeToggle({ theme, setTheme }) {
    const dark = theme === "sentinel-dark";
    return (
      <button className="iconbtn" onClick={() => setTheme(dark ? "sentinel-light" : "sentinel-dark")}
        aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"}>
        <Icon name={dark ? "sun" : "moon"} size={17} />
      </button>
    );
  }

  function NetworkPill({ net, onSwitch }) {
    const isTest = net === "testnet";
    return (
      <button className={"netpill" + (isTest ? " testnet" : "")} onClick={onSwitch} title="Switch network">
        <span className="dot" style={{ background: isTest ? "var(--warning)" : "var(--success)" }} />
        {chains[net].label}
        <Icon name="chevron-down" size={14} style={{ opacity: 0.6 }} />
      </button>
    );
  }

  function WalletButton({ wallet, onConnect, onManage }) {
    if (!wallet.connected) {
      return <button className="wallet-btn" onClick={onConnect}><Icon name="wallet" size={16} />Connect</button>;
    }
    return (
      <button className="wallet-chip" onClick={onManage} title="Account">
        <span className="num">{f.usd(wallet.balance, { cents: false })} USDC</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 8, borderLeft: "1px solid var(--border)" }}>
          <span className="avatar" /><span className="mono">{f.shortAddr(wallet.address, 4, 4)}</span>
        </span>
      </button>
    );
  }

  function Topbar({ route, go, theme, setTheme, net, onSwitchNet, wallet, onConnect, onManage }) {
    return (
      <header className="topbar">
        <div className="topbar-inner">
          <Brand onClick={(e) => { e.preventDefault(); go("dashboard"); }} />
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => (
              <a key={n.route} href={"#" + n.route} className={"nav-tab" + (route === n.route ? " active" : "")}
                aria-current={route === n.route ? "page" : undefined}
                onClick={(e) => { e.preventDefault(); go(n.route); }}>
                <Icon name={n.icon} size={16} />{n.label}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <NetworkPill net={net} onSwitch={onSwitchNet} />
            <ThemeToggle theme={theme} setTheme={setTheme} />
            <WalletButton wallet={wallet} onConnect={onConnect} onManage={onManage} />
          </div>
        </div>
      </header>
    );
  }

  function MobileNav({ route, go }) {
    return (
      <nav className="mobile-nav" aria-label="Primary mobile">
        {NAV.map((n) => (
          <button key={n.route} className={"mobile-tab" + (route === n.route ? " active" : "")}
            aria-current={route === n.route ? "page" : undefined} onClick={() => go(n.route)}>
            <Icon name={n.icon} size={20} />{n.label}
          </button>
        ))}
      </nav>
    );
  }

  // Global banners (§8): wrong-network / paused / kill-switch
  function Banners({ wrongNet, paused, killed, onSwitch }) {
    return (
      <>
        {wrongNet && (
          <div className="banner err" role="alert">
            <div className="banner-inner">
              <Icon name="alert-triangle" size={18} />
              <span style={{ flex: 1 }}>You're connected to an unsupported network. Write actions are disabled.</span>
              <button className="btn btn-danger btn-sm" onClick={onSwitch}>Switch to Mantle</button>
            </div>
          </div>
        )}
        {killed && !wrongNet && (
          <div className="banner err" role="alert">
            <div className="banner-inner">
              <Icon name="lock" size={18} />
              <span style={{ flex: 1 }}><strong>Emergency withdraw-only.</strong> The kill-switch is active — deposits are disabled, withdrawals remain open.</span>
            </div>
          </div>
        )}
        {paused && !killed && !wrongNet && (
          <div className="banner warn" role="alert">
            <div className="banner-inner">
              <Icon name="info" size={18} />
              <span style={{ flex: 1 }}><strong>Deposits paused.</strong> The vault is temporarily not accepting deposits. Withdrawals remain open.</span>
            </div>
          </div>
        )}
      </>
    );
  }

  function Footer() {
    const { explorer } = window.SENTINEL;
    return (
      <footer className="footer">
        <div className="footer-inner">
          <span>Sentinel — autonomous, on-chain risk-guardian vault on Mantle.</span>
          <span style={{ flex: 1 }} />
          <a href="#" onClick={(e) => e.preventDefault()}><Icon name="external-link" size={13} />Repo</a>
          <a href="#" onClick={(e) => e.preventDefault()}><Icon name="external-link" size={13} />Docs</a>
          <a href={explorer + "/address/" + window.SENTINEL.tokens.USDC.address} target="_blank" rel="noreferrer"><Icon name="external-link" size={13} />Contract on Mantlescan</a>
        </div>
      </footer>
    );
  }

  Object.assign(window, { Topbar, MobileNav, Banners, Footer, NAV });
})();
