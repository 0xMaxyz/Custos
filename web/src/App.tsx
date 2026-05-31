// App controller: routing, theme, modal host, toasts. Wallet/chain state comes
// from wagmi (useAccount) + RainbowKit; the topbar ConnectButton drives connect,
// account, and chain switching.

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Icon } from "./components/Icons";
import { Topbar, MobileNav, Banners, Footer, type Route } from "./components/Shell";
import { DevFlags, type AppFlags } from "./components/DevFlags";
import { DepositModal, WithdrawModal, type ToastPayload } from "./modals/TradeModals";
import { DashboardPage } from "./pages/DashboardPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentPage } from "./pages/AgentPage";
import { InsightsPage } from "./pages/InsightsPage";
import { vault, position, walletUsdcBalance } from "./lib/data";
import { supportedChains } from "./lib/chains";

const ROUTES: Route[] = ["dashboard", "activity", "agent", "insights"];
const SUPPORTED_IDS = supportedChains.map((c) => c.id) as number[];

type ModalState = { type: "deposit" } | { type: "withdraw" } | null;
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
  const [route, go] = useHashRoute();
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<AppFlags>({
    paused: vault.paused, killed: vault.killed, wrongNet: false, emptyPosition: false, activityError: false,
  });

  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  // Demo wrong-net flag OR a genuinely unsupported chain while connected.
  const wrongNet = (flags.wrongNet || (isConnected && chainId !== undefined && !SUPPORTED_IDS.includes(chainId)));

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

  // Not connected → open RainbowKit's connect modal; otherwise run the action.
  const needWallet = (next: () => void) => { if (!isConnected) { openConnectModal?.(); } else { next(); } };

  // Wallet balance is still a fixture until live ERC-20 reads land (see useVaultData seam).
  const tradeWallet = { connected: isConnected, address, balance: walletUsdcBalance };

  const pageProps = {
    connected: isConnected, paused: flags.paused, killed: flags.killed,
    emptyPosition: flags.emptyPosition, go, loading,
    onConnect: () => openConnectModal?.(),
    onDeposit: () => needWallet(() => setModal({ type: "deposit" })),
    onWithdraw: () => needWallet(() => setModal({ type: "withdraw" })),
    onToast: pushToast,
  };

  return (
    <div className="app-root" data-theme={theme}>
      <Topbar route={route} go={go} theme={theme} setTheme={setThemeState} />
      <Banners wrongNet={wrongNet} paused={flags.paused} killed={flags.killed} />
      <main>
        {route === "dashboard" && <DashboardPage {...pageProps} />}
        {route === "activity" && <ActivityPage loading={loading} activityError={flags.activityError} />}
        {route === "agent" && <AgentPage loading={loading} />}
        {route === "insights" && <InsightsPage loading={loading} />}
      </main>
      <Footer />
      <MobileNav route={route} go={go} />

      {modal?.type === "deposit" && isConnected && <DepositModal wallet={tradeWallet} vault={vault} onClose={() => setModal(null)} onToast={pushToast} />}
      {modal?.type === "withdraw" && <WithdrawModal position={position} vault={vault} onClose={() => setModal(null)} onToast={pushToast} />}

      <Toasts items={toasts} dismiss={dismiss} />
      {import.meta.env.DEV && <DevFlags flags={flags} setFlags={setFlags} />}
    </div>
  );
}
