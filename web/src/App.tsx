// App controller: routing, theme/network/wallet state, modal host, toasts. Matches Design/src/app.jsx.

import { useState, useEffect, useCallback } from "react";
import { Icon } from "./components/Icons";
import { Topbar, MobileNav, Banners, Footer, type Route, type NetKey, type WalletState } from "./components/Shell";
import { DevFlags, type AppFlags } from "./components/DevFlags";
import { ConnectModal, NetworkSwitchModal, AccountModal } from "./modals/Modals";
import { DepositModal, WithdrawModal, type ToastPayload } from "./modals/TradeModals";
import { DashboardPage } from "./pages/DashboardPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentPage } from "./pages/AgentPage";
import { InsightsPage } from "./pages/InsightsPage";
import * as fmt from "./lib/fmt";
import { vault, position, walletUsdcBalance } from "./lib/data";

const ROUTES: Route[] = ["dashboard", "activity", "agent", "insights"];
const MOCK_WALLET = { address: "0xA11c3b9D7e2F4a8c6B0d1E5f9A3c7B2d4E6f8A0E", balance: walletUsdcBalance, connector: "MetaMask" };

type ModalState =
  | { type: "connect" }
  | { type: "network" }
  | { type: "account" }
  | { type: "deposit" }
  | { type: "withdraw" }
  | null;

interface Toast extends ToastPayload { id: number; }

function useHashRoute(): [Route, (r: Route) => void] {
  const get = (): Route => {
    const h = (location.hash || "").replace("#", "");
    return (ROUTES as string[]).includes(h) ? (h as Route) : "dashboard";
  };
  const [route, setRoute] = useState<Route>(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    location.hash = r;
    setRoute(r);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);
  return [route, go];
}

function Toasts({ items, dismiss }: { items: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-wrap" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"toast " + (t.kind || "info")} role="status">
          <Icon name={t.kind === "success" ? "check-circle" : t.kind === "error" ? "alert-triangle" : "info"} size={17}
            style={{ color: `var(--${t.kind === "success" ? "success" : t.kind === "error" ? "error" : "info"})`, flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{t.title}</div>
            {t.body && <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 2 }}>{t.body}</div>}
          </div>
          <button className="iconbtn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [theme, setThemeState] = useState(() =>
    localStorage.getItem("sentinel-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "sentinel-dark" : "sentinel-light")
  );
  const [net, setNet] = useState<NetKey>("mainnet");
  const [wallet, setWallet] = useState<WalletState>({ connected: false });
  const [route, go] = useHashRoute();
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<AppFlags>({
    paused: vault.paused, killed: vault.killed, wrongNet: false, emptyPosition: false, activityError: false,
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("sentinel-theme", theme);
  }, [theme]);

  useEffect(() => {
    const id = setTimeout(() => setLoading(false), 650);
    return () => clearTimeout(id);
  }, []);

  const pushToast = useCallback((t: ToastPayload) => {
    const id = Date.now() + Math.random();
    setToasts((arr) => [...arr, { id, ...t }]);
    setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismiss = (id: number) => setToasts((arr) => arr.filter((x) => x.id !== id));

  const connect = (connector: { name: string }) => {
    setWallet({ connected: true, ...MOCK_WALLET, connector: connector.name });
    setModal(null);
    pushToast({ kind: "success", title: "Wallet connected", body: fmt.shortAddr(MOCK_WALLET.address, 6, 4) });
  };
  const disconnect = () => { setWallet({ connected: false }); pushToast({ kind: "info", title: "Wallet disconnected" }); };
  const needWallet = (next: () => void) => { if (!wallet.connected) { setModal({ type: "connect" }); } else { next(); } };

  const pageProps = {
    connected: wallet.connected, paused: flags.paused, killed: flags.killed,
    emptyPosition: flags.emptyPosition, go, loading,
    onConnect: () => setModal({ type: "connect" }),
    onDeposit: () => needWallet(() => setModal({ type: "deposit" })),
    onWithdraw: () => needWallet(() => setModal({ type: "withdraw" })),
    onToast: pushToast,
  };

  return (
    <div className="app-root" data-theme={theme}>
      <Topbar route={route} go={go} theme={theme} setTheme={setThemeState} net={net}
        onSwitchNet={() => setModal({ type: "network" })} wallet={wallet}
        onConnect={() => setModal({ type: "connect" })} onManage={() => setModal({ type: "account" })} />
      <Banners wrongNet={flags.wrongNet && wallet.connected} paused={flags.paused} killed={flags.killed} onSwitch={() => setModal({ type: "network" })} />
      <main>
        {route === "dashboard" && <DashboardPage {...pageProps} />}
        {route === "activity" && <ActivityPage loading={loading} activityError={flags.activityError} />}
        {route === "agent" && <AgentPage loading={loading} />}
        {route === "insights" && <InsightsPage loading={loading} />}
      </main>
      <Footer />
      <MobileNav route={route} go={go} />

      {modal?.type === "connect" && <ConnectModal onClose={() => setModal(null)} onConnect={connect} />}
      {modal?.type === "network" && <NetworkSwitchModal net={net} onClose={() => setModal(null)} onSwitch={setNet} />}
      {modal?.type === "account" && wallet.connected && <AccountModal wallet={wallet} net={net} onClose={() => setModal(null)} onDisconnect={disconnect} onSwitchNet={() => setModal({ type: "network" })} />}
      {modal?.type === "deposit" && wallet.connected && <DepositModal wallet={wallet} vault={vault} onClose={() => setModal(null)} onToast={pushToast} />}
      {modal?.type === "withdraw" && <WithdrawModal position={position} vault={vault} onClose={() => setModal(null)} onToast={pushToast} />}

      <Toasts items={toasts} dismiss={dismiss} />
      <DevFlags flags={flags} setFlags={setFlags} />
    </div>
  );
}
