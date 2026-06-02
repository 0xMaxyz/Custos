# Custos — UI / UX Plan

Design spec for the frontend, intended as the brief for generating screens (Claude
design). Stack is fixed: **React + Vite + Tailwind + daisyUI**, wallet via
**RainbowKit + wagmi + viem**. Read alongside `PLAN.md`, `SPEC.md`, `ROADMAP.md`.

> **Render real data, not invented numbers.** Every screen's field names, enums, and
> example values are pinned in **§15 (taxonomy)**, **§16 (data dictionary)**, and
> **§17 (example fixtures)** — drawn from the live contracts (`YieldVault`,
> `Guardrails`, `AgentBenchmark`) and the agent schema (`SPEC.md` §3). Use them
> verbatim so generated screens show the values the app actually emits.

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
  "custos-light": {
    "primary": "#7c3aed", "primary-content": "#ffffff",
    "secondary": "#64748b", "accent": "#7c3aed",
    "neutral": "#1e293b",
    "base-100": "#ffffff", "base-200": "#f8fafc", "base-300": "#e2e8f0",
    "base-content": "#0f172a",
    "info": "#2563eb", "success": "#16a34a", "warning": "#d97706", "error": "#dc2626",
    "--rounded-box": "0.75rem", "--rounded-btn": "0.5rem"
  },
  "custos-dark": {
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
│ [Custos logo]   Dashboard  Activity  Agent  Insights │
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
- **Baseline counter (hero — the Turing-Test answer):** a prominent, always-visible
  comparison **"Custos vs a passive 100% USDY holder"** — running **bps delta**
  (`passiveDeltaBps`) since inception / last de-risk, **drawdown avoided**
  (`drawdownAvoidedUsdc`, USD) summed across de-risk events, and **realized yield**
  (`realizedYieldBps`). Render as a paired stat ("Passive USDY +X bps · Custos
  +Y bps · avoided −Z bps drawdown") with a small sparkline. This is the single most
  important number on the page; legible disconnected (vault-wide) and personalized to
  the user's position when connected. Source: `AgentBenchmark` outcomes (§16).
- **Allocation card:** donut or stacked bar across IDLE / AAVE / USDY / AUSD with %
  and USD; legend; "instantly withdrawable" figure (idle + Aave) called out and
  checked against the **15% instant-liquidity floor**. The **USDY (RWA core) slice is
  held as USDY *and/or* mUSD** (the two on-chain forms of the same bucket, converted
  1:1-by-NAV via the Ondo wrap/unwrap converter — task 2.7); show the form split as a
  sublabel (e.g. "RWA core 50% — 30% mUSD · 20% USDY") since `totalAssets` is
  conserved across a conversion. mUSD is valued at $1 face, USDY at oracle NAV.
- **Vault stats:** TVL (vs `tvlCap` **$50k**), **blended APY** with an expandable
  breakdown (**USDY implied APY** vs **Aave supply APY** — the yield spread the agent
  weighs), **USDY peg** (oracle NAV vs DEX spot, deviation in bps against the
  0.3 / 0.5 / 1.0% thresholds), and **oracle status** (range-based: "valid until
  〈date〉" / "range ends in 2 days" — **not** a Chainlink "last-updated" staleness;
  see §15.3).
- **States:** not-connected (position card → connect CTA, vault stats still visible
  read-only), loading skeletons, empty (no deposit yet → "Make your first deposit").

### 5.2 `/activity` — Risk-Guardian feed (the differentiator)
**Purpose:** the transparent, on-chain decision log — the "wow" + AI-interaction score.
- **Timeline** of `Decision` events (newest first). Each item:
  - kind badge (Rebalance / **De-risk**), timestamp, risk level color.
  - one-line plain-language summary ("Rotated 30% USDY → AUSD: DEX price 1.1% below
    NAV").
  - allocation **before → after** mini-bars (all four buckets, `preWeightsBps` →
    `postWeightsBps`).
  - **evidence/signal chips** typed by signal (**Peg · Oracle · Liquidity ·
    Attestation · News**, §15.1) with **severity** (Low/Med/High) coloring; each
    links its source. Evidence the agent **paid for via x402** (A4.1) carries a small
    **"Paid"** badge with the settlement receipt (amount + tx) — proof "the agent paid
    for the evidence it acted on" (§15.5).
  - **confidence** indicator (the agent's `confidence`, 0–1) and a small **"guardrails
    enforced"** mark (the action stayed within on-chain limits).
  - **Verifiable-Job chip (ERC-8183, A4.2)** on de-risk items: the escrowed-Job status
    (`Funded → Submitted → Completed`/`Rejected`) showing the de-risk was **settled by
    the deterministic guardrail Evaluator** — the "guardrails are the evaluator" thesis
    made literal; links the reputation entry it wrote (§15.4).
  - **outcome strip** once measured: realized bps, **passive-delta bps**, drawdown
    avoided — or "measuring…" while `measuredAt == 0`.
  - tx link (mantlescan), `rationaleHash`.
- **Filters:** All / De-risk only / Rebalance (+ by risk level). **Decision detail
  modal** on click: full **rationale** text, **risk verdict** (`riskLevel` +
  `confidence`), the **deterministic flags** that fired (PEG_WARN /
  ORACLE_NEAR_RANGE_END / LOW_LIQUIDITY, §15.2), **all signals** (type · severity ·
  summary) each tied to its **evidence** (source · publishedAt · link), **before →
  after** weights for all four buckets, the **guardrail ceiling** in force that cycle
  (`maxUsdyWeightBpsAllowed`), and the **outcome** (`realizedYieldBps` ·
  `passiveDeltaBps` · `drawdownAvoidedUsdc` · `measuredAt`). Show `rationaleHash` +
  `decisionURI` (IPFS) for verifiability.
- **States:** loading skeleton rows, empty ("No decisions yet — the agent is
  monitoring"), error (retry).

### 5.3 `/agent` — Agent identity & Ask
**Purpose:** make the autonomous agent tangible + the ERC-8004 identity verifiable.
- **Identity card:** ERC-8004 NFT (agent name, id, agentURI), owner, registry link;
  track record stats (decisions made, de-risk events handled, realized yield,
  drawdown avoided).
- **"What I'm watching" panel:** live signal list, each row **current value vs
  threshold** + status dot (Normal/Caution/De-risk): **USDY peg** (DEX spot vs oracle
  NAV, bps, vs 30 / 50 / 100), **oracle** (range end & age vs `oracleMaxAge` ~28h and
  `oracleRangeEndBuffer` 24h), **Aave utilization** (bps) & **withdrawable** liquidity,
  **instant-liquidity buffer** (IDLE + Aave vs the 15% floor), **AUSD proof-of-reserves**
  (Should).
- **Guardrails / "the limits" panel (trust surface):** the immutable on-chain bounds
  the agent can never cross — **max USDY 60% · max Aave 90% · min idle 2% · min
  instant-liquidity 15% · max slippage 0.5% · max rebalance move 50% · min rebalance
  interval 1h · peg warn/block/de-risk 0.3 / 0.5 / 1.0% · TVL cap $50k · per-tx deposit
  cap $10k · add-strategy timelock 48h**. Makes the "AI proposes, guardrails dispose —
  the model is never the last line of defense" thesis concrete. Source: `packages/shared`
  constants, identical to on-chain `Guardrails.config()` (§16).
- **Ask the agent (Should):** chat panel — "Why am I in AUSD right now?", "What
  changed today?" — answered from decision history + current snapshot. Clearly
  labeled as explanations (read-only; the agent never takes orders from chat).
- **Agent economics (A4 — Could):** a compact panel that makes the agent a verifiable
  economic actor, **clearly labelled as outside the vault custody path**:
  - **x402 (A4.1):** "buys its evidence, sells its judgment." Show premium feeds the
    agent **paid** for (per-call x402 receipts, amount + tx) and the **paid endpoint**
    it exposes — `GET /risk-score`, price (e.g. 0.01 USDC/call), `payTo` — that other
    agents call (the revenue surface). Link receipts to the decisions they backed.
  - **Verifiable jobs (A4.2):** a small ledger of de-risk **ERC-8183 Jobs** — status
    (`Completed`/`Rejected`), the **guardrail Evaluator** verdict, bounty, and the
    ERC-8004 reputation entry each wrote. Reinforces "LLM proposes → validator checks →
    guardrails dispose" as an on-chain, settled record.
- **States:** loading, not-registered (testnet placeholder), chat empty/typing/error;
  the economics panel is hidden when x402 isn't configured / no jobs exist yet.

### 5.4 `/insights` — Risk radar (Should)
**Purpose:** the insight layer (absorbs Option B).
- Charts/cards: USDY **NAV vs DEX price** (peg) over time; **oracle range-end**
  timeline (range-based, per §15.3 — not Chainlink staleness); **AUSD
  proof-of-reserves** status; **Aave USDC utilization & APY**.
- Each chart has a **data-table fallback** for accessibility.
- **States:** loading, error, "data delayed" notice if 1delta lags.

---

## 6. Dialogs / modals

- **Connect wallet** — RainbowKit modal (themed).
- **Deposit** — amount input (USDC, max button, balance), **caps surfaced** (per-tx
  max **$10,000**; vault **$50,000** cap shown as "used $X / $50,000" remaining),
  **preview** (shares out, current share price, projected blended APY), 2-step
  **stepper** Approve → Deposit (skip approve if allowance/permit), risk/disclosure
  note, confirm. Live tx state. Disabled with an explicit reason when a cap is hit or
  the vault is paused.
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
ApyBreakdown (USDY vs Aave), RiskLevelChip, AgentStatusCard, **BaselineCounter**,
DecisionTimelineItem, EvidenceChip, **SignalBadge** (typed + severity), **FlagChip**,
**ConfidenceMeter**, **OutcomeStrip**, IdentityCard, WatchlistPanel, **GuardrailsPanel**
(the limits), **PegGauge**, **LiquidityBufferBar**, ChatPanel, LineChart +
ChartDataTable, Stepper, AmountInput, TxStatus, Toast, Skeletons, EmptyState, ErrorState,
**RwaFormSplit** (USDY vs mUSD sublabel on the RWA slice), **PaidEvidenceBadge** (x402
receipt), **JobStatusChip** (ERC-8183 Open/Funded/Submitted/Completed/Rejected/Expired),
**AgentEconomicsPanel** (x402 spend + paid endpoint + verifiable-jobs ledger).

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
- **Beat-the-baseline, on-chain:** the Baseline counter (§5.1) shows Custos vs a
  passive USDY holder in bps + drawdown avoided — the "can the AI actually beat
  passive?" answer, sourced from the on-chain `AgentBenchmark`.
- **Guardrails made visible:** the Limits panel (§5.3) shows the immutable on-chain
  bounds the agent cannot cross, plus a per-decision "guardrails enforced" mark —
  proof the model is never the last line of defense.
- **Confidence, shown not hidden:** every decision surfaces the agent's `confidence`
  (0–1) next to its risk level, so users can weight its certainty.
- **Pays for its evidence (A4.1):** premium evidence carries a "Paid" badge with the
  x402 receipt — the agent puts money behind the data it acts on, and sells its own
  risk score, making it a transparent economic actor (never from the custody path).
- **Every de-risk is a settled, verifiable job (A4.2):** the de-risk's ERC-8183 Job
  status shows it was released by the deterministic **guardrail Evaluator** and wrote an
  ERC-8004 reputation entry — "AI proposes, guardrails dispose" as an auditable record.

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
| AI Interaction Design 25% | agent status card, plain-language rationale + evidence, confidence, baseline counter, guardrails/limits panel, watchlist, bounded chat (§10) |
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
> can be designed and reviewed before contracts land on testnet. The fixtures in §17
> are the canonical mock set — design and review against those exact values.

---

## 15. Risk-signal, severity & flag taxonomy (enums the UI binds to)

These are closed enum sets — design one swatch/badge per value, don't invent others.

### 15.1 Signal & evidence types
The agent's verdict carries `signals[]` and each links an `evidence[]` item. Type set:

| `type` | Meaning | Default icon (lucide) |
|--------|---------|-----------------------|
| `PEG` | USDY DEX spot deviates from oracle NAV | `activity` |
| `ORACLE` | `RWADynamicOracle` near range end / frozen / paused | `clock-alert` |
| `LIQUIDITY` | Aave or DEX liquidity / buffer pressure | `droplet` |
| `ATTESTATION` | Ondo/USDY reserve attestation finding | `file-check` |
| `NEWS` | Regulatory / issuer / market headline (incl. issuer & regulatory) | `newspaper` |

Each signal has a **severity** → color: `LOW` → info/neutral · `MEDIUM` → warning ·
`HIGH` → error. Evidence item fields: `{ id, type, source, url, publishedAt, summary }`.

### 15.2 Deterministic flags (from the risk engine, pre-LLM)
Shown on the decision detail and "what I'm watching". Closed set:
`NONE` · `PEG_WARN` (peg ≥ 0.3%) · `ORACLE_NEAR_RANGE_END` (within 24h of range end) ·
`LOW_LIQUIDITY` (instant buffer < 15%). These are **deterministic**, not AI — label
them as such (they are not the LLM's opinion).

### 15.3 Risk level → stance, color, oracle wording
| `riskLevel` (0/1/2) | Status color | Agent-status label | What it means |
|---------------------|--------------|--------------------|---------------|
| `NORMAL` | success (green) | **Active · Monitoring** | Within tolerance; earning |
| `CAUTION` | warning (amber) | **Caution** | A signal is elevated; exposure may be tightened |
| `DERISK` | error (red) | **De-risking** | Rotating USDY → AUSD/USDC; defense in progress |

The LLM may only **tighten** (raise level / lower USDY) — never the reverse; reflect
that one-directionality in copy. **Oracle wording:** USDY's oracle is *range-based*
(it interpolates a daily rate), so never say "price feed stale / last updated 3h ago".
Say **"oracle valid until 〈date〉"** or **"range ends in 2 days"**; only a frozen/paused
oracle or one past its range end is "stale".

### 15.4 ERC-8183 Job status (A4.2 — de-risk verifiable jobs)
Closed enum on the de-risk Job (`JobStatusChip`). Color by terminal outcome:

| `status` | Meaning | Color |
|----------|---------|-------|
| `Open` | created, budget not yet escrowed | neutral |
| `Funded` | budget escrowed; awaiting provider | info |
| `Submitted` | provider submitted the de-risk deliverable | info |
| `Completed` | **guardrail Evaluator released it** → provider paid + reputation written | success |
| `Rejected` | de-risk not guardrail-justified → client refunded | warning |
| `Expired` | unsettled past expiry → client refunded | neutral |

The Evaluator is the deterministic guardrail check (`Guardrails.evaluateUsdyRisk`), never
a human or the LLM — label it as such. Jobs are **outside the vault custody path**.

### 15.5 x402 paid-evidence receipt (A4.1)
Evidence the agent bought carries a `PaidEvidenceBadge` from the settlement receipt
`{ success, transaction, network, payer, amount, resource }` (x402 "exact" scheme). Show
amount in the asset's units (e.g. `0.01 USDC`) + a `transaction` explorer link; `resource`
binds the receipt to the evidence item it paid for. Never imply a payment moved vault funds.

---

## 16. Data dictionary (UI element → field → unit → example → source)

Bind to these exact names. Sources: **VAULT** = `YieldVault` read/event · **GR** =
`Guardrails.config()` / `packages/shared` constants · **BM** = `AgentBenchmark` ·
**AGENT** = off-chain agent API / LLM verdict (`SPEC.md` §3) · **CHAIN** = wallet/RPC.

**Position & vault stats (Dashboard §5.1)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| Your shares | `balanceOf(user)` | shares (18-dec) | `30,000.00` | VAULT |
| Current value | `convertToAssets(shares)` | USDC (6-dec) | `$30,142.50` | VAULT |
| Share price | `convertToAssets(1e18)` | USDC/share | `1.0047` | VAULT |
| TVL / cap | `totalAssets()` / `tvlCap` | USDC | `$30,000 / $50,000` | VAULT / GR |
| Blended APY | computed | % | `4.18%` | AGENT |
| └ USDY implied APY | `usdyImpliedApyBps` | bps | `452` (4.52%) | AGENT |
| └ Aave supply APY | `aaveUsdcSupplyApyBps` | bps | `380` (3.80%) | AGENT |
| Allocation weights | current `weightsBps[4]` | bps `[IDLE,AAVE,USDY,AUSD]` | `[300,4700,5000,0]` | VAULT |
| Instantly withdrawable | IDLE + `aaveWithdrawable` | USDC | `$15,000` | VAULT |
| Paused / killed | `paused()` / `isKilled` | bool | `false / false` | VAULT |

**Baseline counter (Dashboard §5.1 hero)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| Passive-delta | `passiveDeltaBps` | bps (signed) | `+180` | BM |
| Drawdown avoided | `drawdownAvoidedUsdc` | USDC (6-dec) | `$610.00` | BM |
| Realized yield | `realizedYieldBps` | bps (signed) | `+45` | BM |
| Measured at | `measuredAt` | unix ts | `1749556800` | BM |

**Agent status & decision (Dashboard §5.1 / Activity §5.2)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| Risk level | `riskLevel` | enum 0/1/2 | `NORMAL` | GR / AGENT |
| Confidence | `confidence` | 0–1 | `0.86` | AGENT |
| Decision id | `id` | uint | `14` | VAULT |
| Kind | `kind` | 0 REBALANCE / 1 DERISK | `1` | VAULT |
| Post weights | `postWeightsBps` | bps[4] | `[500,4500,0,5000]` | VAULT (`Rebalanced` event) |
| Pre weights | `preWeightsBps` | bps[4] | `[300,4700,5000,0]` | AGENT / `decisionURI` (derived from prior `postWeightsBps`) |
| To-bucket (de-risk) | `toBucket` | 0 IDLE / 3 AUSD | `3` | VAULT |
| Rationale (text) | `rationale` | string | "Peg 122 bps below NAV…" | AGENT |
| Rationale hash | `rationaleHash` | bytes32 | `0x9f2c…` | VAULT |
| Decision bundle | `decisionURI` | ipfs:// | `ipfs://bafy…` | VAULT |
| Evidence hash | `evidenceHash` | bytes32 | `0x4ad1…` | VAULT |

**Watchlist & limits (Agent §5.3)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| USDY peg deviation | `usdyDexSpot` vs `usdyOracleNav` | bps | `20` | VAULT |
| Oracle range end | `oracleRangeEnd` | unix ts | `2026-07-01` | VAULT |
| Aave utilization | `aaveUtilizationBps` | bps | `7400` (74%) | AGENT |
| Aave withdrawable | `aaveWithdrawable` | USDC | `$21,000` | VAULT |
| Max USDY weight | `maxWeightBps[USDY]` | bps | `6000` (60%) | GR |
| Min instant liquidity | `minInstantLiquidityBps` | bps | `1500` (15%) | GR |
| Max slippage | `maxSlippageBps` | bps | `50` (0.5%) | GR |
| Peg warn/block/derisk | `pegWarnBps`/`pegBlockBps`/`pegDeRiskBps` | bps | `30 / 50 / 100` | GR |
| Per-tx deposit cap | `perTxDepositCap` | USDC | `$10,000` | GR |

**Identity card (Agent §5.3)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| Agent id | ERC-8004 `agentId` | uint | `7` | CHAIN |
| Agent name / URI | `tokenURI` JSON `{name, agentURI}` | string | `Custos Risk-Guardian` | CHAIN |
| Owner | NFT owner | address | `0xA11c…E0a` | CHAIN |
| Identity registry | ERC-8004 Identity | address | `0x8004A169…a432` | CHAIN |
| Decisions handled | `decisionCount` | uint | `14` | BM |
| De-risk events | count of `kind==1` | uint | `2` | VAULT |

**RWA core form split (Dashboard §5.1 allocation)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| RWA core total | bucket-2 `totalAssets()` | USDC | `$15,000` | VAULT (UsdyAdapter) |
| └ held as USDY | USDY bal × oracle NAV | USDC | `$6,000` | VAULT |
| └ held as mUSD | mUSD bal × $1 face | USDC | `$9,000` | VAULT |
| Converter | `UsdyAdapter.MUSD()` (Ondo wrap/unwrap) | address | `0xab57…7cF3` | CHAIN |

**Agent economics — x402 + verifiable jobs (Agent §5.3, Activity §5.2 — A4)**
| UI element | Field | Unit | Example | Source |
|---|---|---|---|---|
| Paid-evidence amount | receipt `amount` | token base units | `10000` (0.01 USDC) | AGENT (x402) |
| Paid-evidence tx | receipt `transaction` | hash | `0xab12…` | AGENT (x402) |
| Paid-evidence resource | receipt `resource` | url | `https://…/usdy-attestation` | AGENT (x402) |
| Risk-score price | `maxAmountRequired` @ `payTo` | base units @ addr | `10000` @ `0x…bEEF` | AGENT (x402) |
| Job status | ERC-8183 `JobStatus` | enum | `Completed` | JOBS (CustosJobEscrow) |
| Job bounty | `Job.budget` | USDC | `$100.00` | JOBS |
| Job evaluator | `Job.evaluator` | address | `0x…Eval` (guardrail-gated) | JOBS |
| Job reputation | `appendFeedback(tag=DERISK)` | int (score) | `+610` | BM / ERC-8004 |

> **JOBS** = `CustosJobEscrow` / `CustosDeRiskEvaluator` reads — a record layer,
> never the vault custody path.

---

## 17. Canonical example fixtures (design & review against these)

Typed mock data for the screens. Numbers are internally consistent (USDC 6-dec,
USDY 18-dec, chain 5000). Use verbatim.

### 17.1 Chain & token facts
```jsonc
{
  "chains": { "mainnet": 5000, "testnet": 5003 },
  "explorer": "https://mantlescan.xyz",
  "tokens": {
    "USDC": { "decimals": 6,  "address": "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9" },
    "USDY": { "decimals": 18, "address": "0x5bE26527e817998A7206475496fDE1E68957c5A6" },
    "MUSD": { "decimals": 18, "address": "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3" },
    "AUSD": { "decimals": 6,  "address": "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" }
  },
  "erc8004": {
    "identity":   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    "reputation": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
  }
}
```

### 17.2 Vault stats + connected position (Dashboard)
```jsonc
{
  "tvlUsdc": "30000.00", "tvlCapUsdc": "50000.00",
  "blendedApyBps": 418, "usdyImpliedApyBps": 452, "aaveUsdcSupplyApyBps": 380,
  "weightsBps": { "IDLE": 300, "AAVE": 4700, "USDY": 5000, "AUSD": 0 },
  "instantWithdrawableUsdc": "15000.00",
  "usdyOracleNavUsdc": "1.0832", "usdyDexSpotUsdc": "1.0810", "pegDeviationBps": 20,
  "oracleRangeEnd": "2026-07-01T00:00:00Z",
  "paused": false, "killed": false,
  "position": {
    "shares": "30000.00", "valueUsdc": "30142.50", "sharePrice": "1.0047",
    "allTimeYieldUsdc": "142.50"
  }
}
```

### 17.3 Baseline counter (Dashboard hero)
```jsonc
{
  "passiveDeltaBps": 180,            // Custos +1.80% vs a 100%-USDY holder
  "drawdownAvoidedUsdc": "610.00",   // summed across de-risk events
  "realizedYieldBps": 45,
  "sinceDecisionId": 12, "measuredAt": "2026-06-10T12:00:00Z"
}
```

### 17.4 Decision — NORMAL rebalance (Activity item + detail)
```jsonc
{
  "id": 13, "kind": 0, "timestamp": "2026-06-10T12:00:00Z",
  "riskLevel": "NORMAL", "confidence": 0.86,
  "preWeightsBps":  { "IDLE": 300, "AAVE": 4700, "USDY": 5000, "AUSD": 0 },
  "postWeightsBps": { "IDLE": 200, "AAVE": 4800, "USDY": 5000, "AUSD": 0 },
  "flags": ["NONE"], "maxUsdyWeightBpsAllowed": 6000,
  "rationale": "Peg deviation 20 bps within tolerance; USDY APY 4.52% exceeds Aave 3.80%; reserves attestation clean. Hold ~50% USDY.",
  "signals": [
    { "type": "PEG", "severity": "LOW", "summary": "USDY 20 bps below NAV on DEX.", "evidenceId": "e1" }
  ],
  "evidence": [
    { "id": "e1", "type": "ATTESTATION", "source": "ondo.finance",
      "url": "https://ondo.finance/usdy/attestations", "publishedAt": "2026-06-01",
      "summary": "Monthly USDY reserve attestation: 99.4% short T-bills." }
  ],
  "rationaleHash": "0x9f2c…", "decisionURI": "ipfs://bafy…rationale",
  "outcome": { "realizedYieldBps": 12, "passiveDeltaBps": 8, "drawdownAvoidedUsdc": "0.00", "measuredAt": "2026-06-10T13:00:00Z" },
  "txHash": "0xabc…"
}
```

### 17.5 Decision — DE-RISK (the hero moment)
```jsonc
{
  "id": 14, "kind": 1, "timestamp": "2026-06-11T09:30:00Z",
  "riskLevel": "DERISK", "confidence": 0.91, "toBucket": 3,
  "preWeightsBps":  { "IDLE": 300, "AAVE": 4700, "USDY": 5000, "AUSD": 0 },
  "postWeightsBps": { "IDLE": 500, "AAVE": 4500, "USDY": 0,    "AUSD": 5000 },
  "flags": ["PEG_WARN"], "maxUsdyWeightBpsAllowed": 6000,
  "rationale": "USDY traded 122 bps below its Treasury NAV on DEX and an issuer headline flagged a redemption pause review; rotated all USDY to AUSD to protect principal.",
  "signals": [
    { "type": "PEG",  "severity": "HIGH",   "summary": "USDY 122 bps below NAV — past the 1.0% de-risk threshold.", "evidenceId": "e1" },
    { "type": "NEWS", "severity": "MEDIUM", "summary": "Issuer redemption-pause review reported.",                  "evidenceId": "e2" }
  ],
  "evidence": [
    { "id": "e1", "type": "ORACLE", "source": "RWADynamicOracle", "url": "https://mantlescan.xyz/address/0xA96a…", "publishedAt": "2026-06-11", "summary": "Oracle NAV 1.0832 vs DEX spot 1.0700." },
    { "id": "e2", "type": "NEWS",   "source": "reuters.com",      "url": "https://…", "publishedAt": "2026-06-11", "summary": "Report: issuer reviewing temporary redemption pause." }
  ],
  "rationaleHash": "0x4ad1…", "evidenceHash": "0x77be…", "decisionURI": "ipfs://bafy…derisk",
  "outcome": { "realizedYieldBps": 45, "passiveDeltaBps": 180, "drawdownAvoidedUsdc": "610.00", "measuredAt": "2026-06-11T18:00:00Z" },
  "txHash": "0xdef…"
}
```

### 17.6 Watchlist snapshot (Agent §5.3)
```jsonc
[
  { "label": "USDY peg",            "value": "20 bps below NAV", "threshold": "warn 30 / block 50 / derisk 100", "status": "NORMAL" },
  { "label": "Oracle",              "value": "valid until 2026-07-01", "threshold": "range-end buffer 24h", "status": "NORMAL" },
  { "label": "Aave utilization",    "value": "74%", "threshold": "—", "status": "NORMAL" },
  { "label": "Instant-liquidity",   "value": "50% of TVL", "threshold": "min 15%", "status": "NORMAL" },
  { "label": "AUSD reserves (PoR)", "value": "fully reserved", "threshold": "—", "status": "NORMAL" }
]
```

### 17.7 Identity card (Agent §5.3)
```jsonc
{
  "agentId": 7, "name": "Custos Risk-Guardian",
  "agentURI": "ipfs://bafy…agentcard", "owner": "0xA11c…E0a",
  "identityRegistry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "trackRecord": { "decisions": 14, "deRiskEvents": 2, "realizedVsPassivePct": 1.8, "drawdownAvoidedUsdc": "610.00" }
}
```

### 17.8 RWA-core form split + agent economics (A4)
```jsonc
{
  "rwaCore": {                          // bucket 2 held as USDY and/or mUSD (task 2.7)
    "totalUsdc": "15000.00",
    "usdyUsdc": "6000.00",              // USDY bal × oracle NAV
    "musdUsdc": "9000.00",              // mUSD bal × $1 face
    "converter": "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3"  // UsdyAdapter.MUSD()
  },
  "x402": {                             // A4.1 — pays for evidence, sells its risk score
    "paidEvidence": [
      { "evidenceId": "e1", "resource": "https://feeds.example/usdy-attestation",
        "receipt": { "success": true, "transaction": "0xab12…", "network": "mantle",
                     "payer": "0xA11c…E0a", "amount": "10000", "resource": "https://feeds.example/usdy-attestation" } }
    ],
    "sells": { "endpoint": "/risk-score", "priceBaseUnits": "10000", "asset": "USDC", "payTo": "0x000…bEEF" }
  },
  "jobs": [                             // A4.2 — each de-risk as an ERC-8183 verifiable Job
    { "jobId": 3, "status": "Completed", "budgetUsdc": "100.00",
      "evaluator": "0xEval…", "deliverable": "0x…decisionHash",
      "reputation": { "tag": "DERISK", "score": 610, "uri": "ipfs://bafy…evidence" } }
  ]
}
```
