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
import { AllocatorPage } from "./pages/AllocatorPage";
import { useVaultData } from "./lib/useVaultData";
import { useAllocator } from "./lib/useAllocator";
import { supportedChains } from "./lib/chains";
import { resolveInitialTheme } from "./lib/theme";

const ROUTES: Route[] = ["dashboard", "agent", "activity", "allocator"];
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
    <div className="cs-toast-wrap" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"cs-toast " + (t.kind || "info")} role="status">
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
    resolveInitialTheme((k) => localStorage.getItem(k), matchMedia("(prefers-color-scheme: dark)").matches)
  );
  const [route, go] = useHashRoute();
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<AppFlags>({
    paused: false, killed: false, wrongNet: false, emptyPosition: false, activityError: false,
  });

  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { vault, position, usdcAddress, walletUsdc, isLive: vaultLive } = useVaultData(address);
  const { isAllocator } = useAllocator(address);
  // Demo wrong-net flag OR a genuinely unsupported chain while connected.
  const wrongNet = (flags.wrongNet || (isConnected && chainId !== undefined && !SUPPORTED_IDS.includes(chainId)));
  // When vault is live, derive emptyPosition from actual shares; fall back to dev flag.
  const emptyPosition = vaultLive ? parseFloat(position.shares) === 0 : flags.emptyPosition;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("custos-theme", theme);
  }, [theme]);

  useEffect(() => {
    const id = setTimeout(() => setLoading(false), 650);
    return () => clearTimeout(id);
  }, []);

  // Guard the allocator route: if the connected wallet isn't the ALLOCATOR (or
  // disconnects), bounce back to the dashboard so the page can't be reached by hash.
  useEffect(() => {
    if (route === "allocator" && !isAllocator) go("dashboard");
  }, [route, isAllocator, go]);

  const pushToast = useCallback((t: ToastPayload) => {
    const id = Date.now() + Math.random();
    setToasts((arr) => [...arr, { id, ...t }]);
    setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismiss = (id: number) => setToasts((arr) => arr.filter((x) => x.id !== id));

  // Not connected → open RainbowKit's connect modal; otherwise run the action.
  const needWallet = (next: () => void) => { if (!isConnected) { openConnectModal?.(); } else { next(); } };

  // Wallet USDC balance from the live ERC-20 read (fixture in demo/offline).
  const tradeWallet = { connected: isConnected, address, balance: walletUsdc };

  const pageProps = {
    connected: isConnected, paused: flags.paused || vault.paused, killed: flags.killed || vault.killed,
    emptyPosition, go, loading,
    onConnect: () => openConnectModal?.(),
    onDeposit: () => needWallet(() => setModal({ type: "deposit" })),
    onWithdraw: () => needWallet(() => setModal({ type: "withdraw" })),
    onToast: pushToast,
  };

  return (
    <div className="app-root" data-theme={theme}>
      <Topbar route={route} go={go} theme={theme} setTheme={setThemeState} showAllocator={isAllocator} />
      <Banners wrongNet={wrongNet} paused={flags.paused || vault.paused} killed={flags.killed || vault.killed} />
      <main>
        {route === "dashboard" && <DashboardPage {...pageProps} />}
        {route === "agent" && <AgentPage loading={loading} />}
        {route === "activity" && <ActivityPage loading={loading} activityError={flags.activityError} />}
        {route === "allocator" && <AllocatorPage loading={loading} onToast={pushToast} />}
      </main>
      <Footer />
      <MobileNav route={route} go={go} showAllocator={isAllocator} />

      {modal?.type === "deposit" && isConnected && <DepositModal wallet={tradeWallet} vault={vault} usdcAddress={usdcAddress} onClose={() => setModal(null)} onToast={pushToast} />}
      {modal?.type === "withdraw" && <WithdrawModal position={position} vault={vault} onClose={() => setModal(null)} onToast={pushToast} />}

      <Toasts items={toasts} dismiss={dismiss} />
      {import.meta.env.DEV && <DevFlags flags={flags} setFlags={setFlags} />}
    </div>
  );
}
