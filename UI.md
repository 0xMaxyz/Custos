# Sentinel — UI / UX Plan

Design spec for the frontend, intended as the brief for generating screens (Claude
design). Stack is fixed: **React + Vite + Tailwind + daisyUI**, wallet via
**RainbowKit + wagmi + viem**. Read alongside `PLAN.md`, `SPEC.md`, `ROADMAP.md`.

**Design intent:** clean, simple, professional. No fancy colors or fonts. Standard
palette with a **purple** accent. **Light + dark** themes. Optimized for the Best
UI/UX award: Visual Design 30% · Interaction & Flow 30% · **AI Interaction Design
25%** · Accessibility 15%.

> Defaults chosen (flag if you disagree): typeface **Inter** (neutral, professional)
> + monospace for numbers/addresses; primary purple in the **violet** family; chains
> **Mantle mainnet 5000** + **Mantle Sepolia testnet 5003** (verify testnet id in
> Phase 0).

---

## 1. Principles

- **Trust through clarity.** This app moves money autonomously; every number, state,
  and agent action must be legible and explainable. Prefer plain language over jargon.
- **Calm, not flashy.** Generous whitespace, restrained color, one accent (purple).
  Color carries meaning (status), not decoration.
- **Show the "why".** The agent is never a black box — rationale + evidence are
  always one click away.
- **Same skeleton, two themes.** Light/dark are token swaps, not different layouts.
- **Accessible by default.** Keyboard-first, AA contrast, semantic HTML, reduced-motion.

---

## 2. Design tokens

### 2.1 Color (semantic, standard)
- **Primary (purple/violet):** light `#7c3aed` · dark `#8b5cf6`. Hover/active a shade
  darker/lighter. Used for primary actions, active nav, key highlights only.
- **Neutrals:** slate/zinc grays for text, borders, surfaces.
- **Status:** success `#16a34a`, warning `#d97706`, error `#dc2626`, info `#2563eb`
  (standard, slightly muted; used for risk levels & tx states).
- **Risk-level mapping:** NORMAL → success · CAUTION → warning · DERISK → error.

### 2.2 daisyUI themes (config sketch for `tailwind.config`)
```js
// daisyui.themes
{
  "sentinel-light": {
    "primary": "#7c3aed", "primary-content": "#ffffff",
    "secondary": "#64748b", "accent": "#7c3aed",
    "neutral": "#1e293b",
    "base-100": "#ffffff", "base-200": "#f8fafc", "base-300": "#e2e8f0",
    "base-content": "#0f172a",
    "info": "#2563eb", "success": "#16a34a", "warning": "#d97706", "error": "#dc2626",
    "--rounded-box": "0.75rem", "--rounded-btn": "0.5rem"
  },
  "sentinel-dark": {
    "primary": "#8b5cf6", "primary-content": "#0b0710",
    "secondary": "#94a3b8", "accent": "#8b5cf6",
    "neutral": "#0f172a",
    "base-100": "#0b1020", "base-200": "#111827", "base-300": "#1f2937",
    "base-content": "#e5e7eb",
    "info": "#3b82f6", "success": "#22c55e", "warning": "#f59e0b", "error": "#ef4444",
    "--rounded-box": "0.75rem", "--rounded-btn": "0.5rem"
  }
}
```
- Theme persisted via `data-theme` on `<html>` + `localStorage`; default follows
  `prefers-color-scheme`. RainbowKit theme is matched (lightTheme/darkTheme with
  `accentColor` = primary) and switched in lockstep.

### 2.3 Typography
- **UI:** Inter (variable), system fallback `ui-sans-serif, system-ui, sans-serif`.
- **Numbers/addresses/hashes:** `ui-monospace, "JetBrains Mono", monospace` (tabular).
- Scale (rem): 0.75 / 0.875 / 1 / 1.125 / 1.25 / 1.5 / 2 / 2.5. Weights 400/500/600.
- Money: tabular-nums; truncate addresses `0x1234…abcd` with copy + explorer link.

### 2.4 Spacing / shape / motion
- 4px base scale; cards `rounded-box`, buttons `rounded-btn`; subtle 1px borders +
  soft shadow (no heavy drop-shadows). Motion: 150–200ms ease; **respect
  `prefers-reduced-motion`**; no parallax/marquee/“fancy” effects.

### 2.5 Icons
- One line-icon set (lucide-react). Consistent stroke width.

---

## 3. App shell & information architecture

```
┌ Topbar ───────────────────────────────────────────────┐
│ [Sentinel logo]   Dashboard  Activity  Agent  Insights │
│                         [network pill] [theme] [wallet]│
└────────────────────────────────────────────────────────┘
│  Global banners (wrong-network / paused / kill-switch)  │
│  Page content (max-w ~1100px, centered, responsive)     │
└ Footer (links: repo, docs, contract on mantlescan) ─────┘
```
- **Routes (react-router):** `/` Dashboard · `/activity` Risk-Guardian feed ·
  `/agent` Agent · `/insights` Risk radar (Should). Deposit/withdraw are **modals**,
  not routes.
- **Topbar** persistent: nav tabs, **network pill** (Mainnet/Testnet), **theme
  toggle**, **RainbowKit ConnectButton**.
- Mobile: nav collapses to a bottom tab bar or hamburger; content single-column.

---

## 4. Wallet & network (RainbowKit + wagmi + viem)

- **ConnectButton** (RainbowKit) top-right. Connectors: injected/MetaMask, Rabby,
  WalletConnect, Coinbase Wallet.
- **Chains:** Mantle mainnet (5000) + Mantle Sepolia testnet (5003). `wagmi` config
  with viem transports (our RPC + fallback). RainbowKit theme matched to light/dark.
- **Network pill** shows current chain; clicking opens RainbowKit chain switcher.
- **Wrong-network guard:** if connected to an unsupported chain, show a sticky
  warning banner + "Switch to Mantle" button; disable all write actions.
- **Account states:** Disconnected (CTA to connect) · Connected (address, balance,
  ENS/avatar if any) · Connecting/Reconnecting (skeleton).
- **Reads** use wagmi hooks over viem; **writes** go through viem wallet client with
  our typed contract ABIs. TanStack Query (bundled with wagmi) handles caching.

---

## 5. Pages

### 5.1 `/` — Dashboard (home)
**Purpose:** at-a-glance position + vault health + the single most important agent state.
- **Hero strip (works disconnected):** product one-liner + "Connect to deposit"; if
  connected, replaced by the user position summary.
- **Agent status card (prominent):** big status chip — `Active · Monitoring` /
  `Caution` / `De-risking` (color = risk level), last-action timestamp, "View
  reasoning" link to `/activity`. This is the trust anchor.
- **Your position:** deposited value, current value, shares, all-time yield, blended
  APY. Primary buttons **Deposit** / **Withdraw** (open modals).
- **Allocation card:** donut or stacked bar across IDLE / AAVE / USDY / AUSD with %
  and USD; legend; "instantly withdrawable" figure (idle + Aave) called out.
- **Vault stats:** TVL (vs cap), current blended APY, USDY peg status (NAV vs DEX),
  oracle freshness.
- **States:** not-connected (position card → connect CTA, vault stats still visible
  read-only), loading skeletons, empty (no deposit yet → "Make your first deposit").

### 5.2 `/activity` — Risk-Guardian feed (the differentiator)
**Purpose:** the transparent, on-chain decision log — the "wow" + AI-interaction score.
- **Timeline** of `Decision` events (newest first). Each item:
  - kind badge (Rebalance / **De-risk**), timestamp, risk level color.
  - one-line plain-language summary ("Rotated 30% USDY → AUSD: DEX price 1.1% below
    NAV").
  - allocation **before → after** mini-bars.
  - **evidence chips** (Attestation / News / Peg / Oracle) linking sources.
  - tx link (mantlescan), rationale hash.
- **Filters:** All / De-risk only / Rebalance. **Decision detail modal** on click
  (full rationale text, all evidence with sources, before/after, outcome once known).
- **States:** loading skeleton rows, empty ("No decisions yet — the agent is
  monitoring"), error (retry).

### 5.3 `/agent` — Agent identity & Ask
**Purpose:** make the autonomous agent tangible + the ERC-8004 identity verifiable.
- **Identity card:** ERC-8004 NFT (agent name, id, agentURI), owner, registry link;
  track record stats (decisions made, de-risk events handled, realized yield,
  drawdown avoided).
- **"What I'm watching" panel:** live list of monitored signals (USDY peg, oracle
  freshness, Aave utilization, AUSD reserves) with current values + thresholds.
- **Ask the agent (Should):** chat panel — "Why am I in AUSD right now?", "What
  changed today?" — answered from decision history + current snapshot. Clearly
  labeled as explanations (read-only; the agent never takes orders from chat).
- **States:** loading, not-registered (testnet placeholder), chat empty/typing/error.

### 5.4 `/insights` — Risk radar (Should)
**Purpose:** the insight layer (absorbs Option B).
- Charts/cards: USDY **NAV vs DEX price** (peg) over time; **oracle freshness**
  timeline; **AUSD proof-of-reserves** status; **Aave USDC utilization & APY**.
- Each chart has a **data-table fallback** for accessibility.
- **States:** loading, error, "data delayed" notice if 1delta lags.

---

## 6. Dialogs / modals

- **Connect wallet** — RainbowKit modal (themed).
- **Deposit** — amount input (USDC, max button, balance), **preview** (shares out,
  current share price, projected blended APY), 2-step **stepper** Approve → Deposit
  (skip approve if allowance/permit), risk/disclosure note, confirm. Live tx state.
- **Withdraw** — amount in USDC or shares (toggle), **preview** (USDC out, share
  price), **liquidity note** ("served from instant liquidity"; warn if large
  withdrawal may unwind USDY with slippage), confirm.
- **Transaction status** — pending / confirmed / failed, with mantlescan link;
  surfaced as a modal step and a toast.
- **Decision detail** — full rationale, evidence list (sourced links), before/after
  allocation, outcome.
- **Network switch** — prompt when on wrong chain.
- **Settings popover** — theme toggle, network toggle, links.
- Modal rules: focus-trapped, Esc to close, scroll-locked, labelled (`aria-modal`),
  return focus to trigger.

---

## 7. Shared components inventory

Topbar, NavTabs, NetworkPill, ThemeToggle, WalletButton (RainbowKit), Banner
(warning/paused), StatCard, MoneyValue (tabular + USD), TokenAmount, AddressChip
(copy + explorer), AllocationChart (donut/stacked bar) + AllocationLegend, APYBadge,
RiskLevelChip, AgentStatusCard, DecisionTimelineItem, EvidenceChip, IdentityCard,
WatchlistPanel, ChatPanel, LineChart + ChartDataTable, Stepper, AmountInput,
TxStatus, Toast, Skeletons, EmptyState, ErrorState.

---

## 8. Global states & edge cases

- **Not connected:** read-only vault stats visible; write actions → connect CTA.
- **Wrong network:** sticky banner + switch; writes disabled.
- **Paused / kill-switch active:** prominent banner ("Deposits paused / Emergency
  withdraw-only"); deposit disabled, withdraw enabled.
- **Loading:** skeletons (never spinners-only for layout).
- **Empty:** friendly guidance + primary action.
- **Error:** inline with retry; toasts for transient failures; never dead-ends.
- **Stale data:** "updated Xs ago" labels; subtle "data delayed" pill if 1delta lags.

---

## 9. Responsive & accessibility (targets the 15%)

- Breakpoints: mobile <640, tablet 640–1024, desktop >1024. Single-column mobile;
  cards stack; charts shrink to sparklines + table.
- **A11y:** semantic landmarks; full keyboard nav + visible focus rings; AA contrast
  in both themes; ARIA for modals/tabs/toasts; charts have table fallbacks + alt
  summaries; `prefers-reduced-motion` honored; min 44px touch targets; form labels +
  error messaging; color never the only signal (icon + text with status).

---

## 10. AI interaction design (targets the 25%)

- **Status, always visible:** the Agent Status card on the dashboard makes the
  agent's current stance obvious at a glance (Monitoring / Caution / De-risking).
- **Plain-language reasoning:** every decision has a human sentence first, details
  on demand. No raw JSON in the primary view.
- **Evidence, not assertions:** each risk claim links to its source (attestation,
  news, on-chain reading) via evidence chips.
- **Confidence & limits:** show the agent's confidence and make clear it acts only
  within on-chain guardrails (a small "guardrails enforced" affordance).
- **Conversational, bounded:** Ask-the-agent explains; it never executes from chat.
- **Live "what I'm watching":** turns an invisible loop into something observable —
  the "radical transparency" theme made tangible.

---

## 11. Microcopy & tone

- Calm, factual, confidence-building. Short labels; verbs on buttons ("Deposit",
  "Withdraw", "Switch to Mantle"). Explain risk plainly ("USDY traded 1.1% below its
  Treasury value, so funds were moved to AUSD"). Avoid hype and emojis.

---

## 12. Mapping to UI/UX award criteria

| Criterion | Where we earn it |
|---|---|
| Visual Design 30% | restrained purple/neutral system, consistent tokens, two clean themes |
| Interaction & Flow 30% | clear deposit/withdraw steppers, responsive shell, skeleton/empty/error states, smooth ≤200ms motion |
| AI Interaction Design 25% | agent status card, plain-language rationale + evidence, watchlist, bounded chat (§10) |
| Accessibility 15% | keyboard/contrast/ARIA/chart-tables/reduced-motion (§9) |

---

## 13. Tech implementation notes

- **Libs:** react-router, @rainbow-me/rainbowkit, wagmi, viem, @tanstack/react-query
  (via wagmi), tailwindcss, daisyui, lucide-react, a light chart lib (recharts or
  visx) with table fallback. **Backend/agent also use viem** (no ethers).
- **Theming:** daisyUI two custom themes (§2.2) toggled via `data-theme`; RainbowKit
  `lightTheme`/`darkTheme` matched to primary; single theme context.
- **Data layer:** wagmi hooks (reads) + viem wallet client (writes); contract ABIs &
  addresses imported from `packages/shared`; agent/API endpoints (Fastify) for
  decision history, evidence resolution (IPFS), and Ask-the-agent.
- **Env:** RPC URLs, WalletConnect projectId, API base — via Vite env; never commit.

---

## 14. Build order (aligns with ROADMAP Phase 4)

1. **Shell + theming + wallet** (topbar, two themes, theme toggle, RainbowKit/wagmi
   config, network guard) — ROADMAP 4.3.
2. **Dashboard reads** (agent status, position, allocation, vault stats) — 4.4.
3. **Deposit/Withdraw modals** (steppers, previews, tx status) — 4.5.
4. **Risk-Guardian feed + decision detail** — 4.6.
5. **Identity card** — 4.7.
6. **Risk radar + Ask-the-agent** (Should) — 4.8 / 5.4.

> Build with mock data first (typed fixtures), then wire to chain/agent so screens
> can be designed and reviewed before contracts land on testnet.
