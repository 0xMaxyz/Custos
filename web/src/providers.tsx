// Wallet + data providers: wagmi (viem transport) + RainbowKit + react-query.
// Mantle-only chain set from lib/chains.

import "@rainbow-me/rainbowkit/styles.css";
import type { ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { fallback } from "viem";
import { injected } from "wagmi/connectors";
import { RainbowKitProvider, getDefaultConfig, lightTheme, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mantleMainnet, mantleTestnet, supportedChains, DEFAULT_CHAIN, MAINNET_RPCS, TESTNET_RPCS } from "./lib/chains";

// WalletConnect Cloud project id. Falls back to a placeholder so local dev /
// tests don't crash; set VITE_WALLETCONNECT_PROJECT_ID for real WC sessions.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "custos-local-dev";

// Build a fail-over transport over a pool of public RPCs. `retryCount: 1` per endpoint
// so a rate-limited (429) provider is abandoned for the next one quickly instead of
// being hammered — the point is to spread load, not retry one throttled URL. `rank`
// reorders by latency/stability over time so the healthiest endpoint serves most reads.
function poolTransport(urls: string[]) {
  return fallback(
    urls.map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 12_000 })),
    { rank: { interval: 60_000, sampleCount: 3 }, retryCount: 1 },
  );
}

const transports = {
  [mantleMainnet.id]: poolTransport(MAINNET_RPCS),
  [mantleTestnet.id]: poolTransport(TESTNET_RPCS),
};

// Aggregate concurrent eth_calls through Multicall3 (one request instead of N) — the
// single biggest cut to the per-render RPC count, which is what was tripping public-RPC
// 429s. Batch a short window of in-flight reads together.
const batch = { multicall: { wait: 32 } } as const;

export const wagmiConfig = projectId === "custos-local-dev"
  // Without a real WC project id, RainbowKit's WalletConnect connector errors — fall
  // back to a config with the `injected()` connector (MetaMask/Rabby/Brave + any
  // EIP-6963 wallet) so connecting (and therefore depositing) still works. Only mobile
  // WalletConnect sessions need VITE_WALLETCONNECT_PROJECT_ID.
  ? createConfig({
      chains: supportedChains,
      connectors: [injected()],
      transports,
      batch,
    })
  : getDefaultConfig({
      appName: "Custos",
      projectId,
      chains: supportedChains,
      transports,
      batch,
    });

const queryClient = new QueryClient();

export function Providers({ children, theme }: { children: ReactNode; theme: string }) {
  const dark = theme === "custos-dark";
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={DEFAULT_CHAIN}
          theme={dark ? darkTheme({ accentColor: "#7c3aed" }) : lightTheme({ accentColor: "#7c3aed" })}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
