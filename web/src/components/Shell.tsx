// App shell: Topbar, MobileNav, Banners, Footer. Matches Design/src/shell.jsx.

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Icon } from "./Icons";
import { explorer, tokens } from "../lib/data";

const NAV = [
  { route: "dashboard", label: "Dashboard", icon: "layout-dashboard" },
  { route: "activity", label: "Activity", icon: "scroll-text" },
  { route: "agent", label: "Agent", icon: "bot" },
  { route: "insights", label: "Insights", icon: "line-chart" },
] as const;

export type Route = "dashboard" | "activity" | "agent" | "insights";
export type NetKey = "mainnet" | "testnet";

function Brand({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <a className="brand" href="#dashboard" onClick={onClick}>
      <span className="brand-mark"><Icon name="shield-check" size={18} /></span>
      Custos
    </a>
  );
}

function ThemeToggle({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) {
  const dark = theme === "custos-dark";
  return (
    <button className="iconbtn" onClick={() => setTheme(dark ? "custos-light" : "custos-dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"}>
      <Icon name={dark ? "sun" : "moon"} size={17} />
    </button>
  );
}

export function Topbar({ route, go, theme, setTheme }: {
  route: Route; go: (r: Route) => void; theme: string; setTheme: (t: string) => void;
}) {
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
          <ThemeToggle theme={theme} setTheme={setTheme} />
          {/* RainbowKit handles connect, account, and chain switching (incl. wrong-network) */}
          <ConnectButton chainStatus="icon" accountStatus="address" showBalance={false} />
        </div>
      </div>
    </header>
  );
}

export function MobileNav({ route, go }: { route: Route; go: (r: Route) => void }) {
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

export function Banners({ wrongNet, paused, killed }: { wrongNet: boolean; paused: boolean; killed: boolean }) {
  return (
    <>
      {wrongNet && (
        <div className="banner err" role="alert">
          <div className="banner-inner">
            <Icon name="alert-triangle" size={18} />
            <span style={{ flex: 1 }}>You're connected to an unsupported network. Switch to Mantle from the wallet button — write actions are disabled.</span>
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

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Custos — autonomous, on-chain risk-guardian vault on Mantle.</span>
        <span style={{ flex: 1 }} />
        <a href="#" onClick={(e) => e.preventDefault()}><Icon name="external-link" size={13} />Repo</a>
        <a href="#" onClick={(e) => e.preventDefault()}><Icon name="external-link" size={13} />Docs</a>
        <a href={explorer + "/address/" + tokens.USDC.address} target="_blank" rel="noreferrer"><Icon name="external-link" size={13} />Contract on Mantlescan</a>
      </div>
    </footer>
  );
}
