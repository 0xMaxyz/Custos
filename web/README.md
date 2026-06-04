# web

React + Vite + Tailwind + daisyUI frontend for Custos.

## Run

```bash
pnpm -C web dev     # Vite dev server (default port 5173)
pnpm -C web build   # production build → dist/
pnpm -C web test    # vitest component + unit tests
```

## Environment

```bash
VITE_VAULT_ADDRESS=      # deployed YieldVault address — enables live chain reads
VITE_AGENT_API_URL=      # agent service base URL — enables /snapshot and /ask
VITE_AGENT_ID=           # ERC-8004 agent NFT id — enables identity card reads
VITE_WALLETCONNECT_ID=   # WalletConnect project id
```

Without `VITE_VAULT_ADDRESS`, the app runs in **demo mode** (typed fixture data from
`src/lib/data.ts`). Without `VITE_AGENT_API_URL`, the Insights + Ask panels use
fixture answers.

## Pages (hash-based routing)

| Route | Page | Content |
|-------|------|---------|
| `#dashboard` | Dashboard | Position, allocation donut, baseline counter, vault stats |
| `#activity` | Activity | Risk-guardian decision feed + decision-detail modal |
| `#agent` | Agent | Identity card, watchlist, guardrails/limits, Ask-the-agent |
| `#insights` | Insights | Peg, oracle, AUSD PoR, Aave utilization charts |

Deposit/Withdraw are **modals**, not routes.

## Source structure

```
src/
  lib/
    chains.ts           Mantle 5000/5003 wagmi chain config
    useVaultData.ts     Live YieldVault + AgentBenchmark reads (wagmi/viem)
    useGuardianData.ts  DecisionRecorded event index + ERC-8004 reads
    useInsightsData.ts  Polls /snapshot every 15s (Insights page)
    txMachine.ts        Pure deposit/withdraw state machine
    baseline.ts         computeBaseline — Custos vs passive-USDY delta
    decisionUri.ts      Resolve ipfs:// / data: / https: decision URIs
    askAgent.ts         POST /ask client
    data.ts             Typed fixture data (demo mode fallback)
  components/
    Components.tsx      Shared UI components inventory
  pages/
    Dashboard.tsx
    ActivityPage.tsx
    AgentPage.tsx
    InsightsPage.tsx
  App.tsx               Hash router + providers
  providers.tsx         wagmi + RainbowKit + react-query setup
```

## Themes

Two daisyUI-equivalent themes — `custos-light` and `custos-dark` — toggled via
`data-theme` on `.app-root`. Persisted under `custos-theme` in localStorage; default
follows `prefers-color-scheme`.

## In-depth docs

- [docs/ui.md](../docs/ui.md) — design spec, component inventory, data dictionary, fixtures
- [docs/architecture.md](../docs/architecture.md) — system design
- [docs/agents.md](../docs/agents.md) — coding conventions
