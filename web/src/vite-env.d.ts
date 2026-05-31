/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MANTLE_RPC_URL?: string;
  readonly VITE_MANTLE_TESTNET_RPC_URL?: string;
  readonly VITE_DEFAULT_CHAIN?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
