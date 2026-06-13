// Wallet + data providers: wagmi (viem transport) + RainbowKit + react-query.
// Mantle-only chain set from lib/chains.

import "@rainbow-me/rainbowkit/styles.css";
import type { ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { RainbowKitProvider, getDefaultConfig, lightTheme, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mantleMainnet, mantleTestnet, supportedChains, DEFAULT_CHAIN } from "./lib/chains";

// WalletConnect Cloud project id. Falls back to a placeholder so local dev /
// tests don't crash; set VITE_WALLETCONNECT_PROJECT_ID for real WC sessions.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "custos-local-dev";

export const wagmiConfig = projectId === "custos-local-dev"
  // Without a real WC project id, RainbowKit's WalletConnect connector errors — fall
  // back to a config with the `injected()` connector (MetaMask/Rabby/Brave + any
  // EIP-6963 wallet) so connecting (and therefore depositing) still works. Only mobile
  // WalletConnect sessions need VITE_WALLETCONNECT_PROJECT_ID.
  ? createConfig({
      chains: supportedChains,
      connectors: [injected()],
      transports: {
        [mantleMainnet.id]: http(),
        [mantleTestnet.id]: http(),
      },
    })
  : getDefaultConfig({
      appName: "Custos",
      projectId,
      chains: supportedChains,
      transports: {
        [mantleMainnet.id]: http(),
        [mantleTestnet.id]: http(),
      },
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
