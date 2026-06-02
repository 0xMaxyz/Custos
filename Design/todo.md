# Custos — Frontend Build TODO

High-fidelity, interactive HTML prototype generated from `uploads/pasted-1780233108591.txt`
(the Custos UI/UX plan). Stack in the spec is React + Vite + Tailwind + daisyUI; this
prototype mirrors the design with React (inline JSX) + hand-built token CSS so screens can
be designed/reviewed against the canonical fixtures (§17) before contracts land.

Render **real data, not invented numbers** — every value comes from §15–§17 verbatim.

---

## 0. Project setup
- [x] Read the UI plan end to end
- [x] todo.md (this file)

## 1. Foundation — tokens, type, data
- [x] `theme.css` — two daisyUI-equivalent themes (`custos-light` / `custos-dark`) as
      CSS custom properties on `[data-theme]`; primary violet, slate neutrals, status colors,
      `--rounded-box` 0.75rem / `--rounded-btn` 0.5rem (§2.1–2.4)
- [x] Inter (UI) + JetBrains Mono (numbers/addresses, tabular-nums) (§2.3)
- [x] `data.js` — canonical fixtures (§17) + guardrail constants (§16) + taxonomy enums
      (signal types, severity, flags, risk levels §15), exported to `window`

## 2. App shell & IA (§3, §14.1)
- [x] Topbar: logo, nav tabs (Dashboard / Activity / Agent / Insights), network pill,
      theme toggle, wallet button
- [x] Client-side routing (hash) across the 4 routes; deposit/withdraw are modals not routes
- [x] Global banners: wrong-network / paused / kill-switch (§8)
- [x] Footer: repo, docs, contract on mantlescan
- [x] Responsive: mobile bottom tab bar / single column (§9)

## 3. Shared components (§7)
- [x] StatCard, MoneyValue (tabular + USD), TokenAmount, AddressChip (copy + explorer)
- [x] RiskLevelChip, AgentStatusCard, ConfidenceMeter, APYBadge, ApyBreakdown
- [x] AllocationChart (donut) + AllocationLegend, LiquidityBufferBar, PegGauge
- [x] BaselineCounter (+ sparkline), DecisionTimelineItem, EvidenceChip, SignalBadge,
      FlagChip, OutcomeStrip
- [x] LineChart + ChartDataTable, Stepper, AmountInput, TxStatus, Toast,
      Skeleton, EmptyState, ErrorState

## 4. Dashboard `/` (§5.1, §14.2)
- [x] Hero strip (disconnected: connect CTA; connected: position summary)
- [x] Agent status card (prominent trust anchor) → link to Activity
- [x] Baseline counter — Custos vs passive USDY holder (the Turing-test number)
- [x] Your position (deposited/current value, shares, all-time yield, blended APY) + Deposit/Withdraw
- [x] Allocation donut across IDLE/AAVE/USDY/AUSD + instantly-withdrawable + 15% floor check
- [x] Vault stats: TVL vs cap, blended APY breakdown, USDY peg, oracle status (range-based)
- [x] States: not-connected / loading / empty (via Demo states panel)

## 5. Activity `/activity` (§5.2, §14.4)
- [x] Decision timeline (newest first): kind badge, summary, before→after mini-bars,
      signal/evidence chips, confidence, guardrails-enforced mark, outcome strip, tx link,
      rationaleHash in footer
- [x] Filters: All / De-risk / Rebalance + by risk level
- [x] Decision detail modal: rationale, risk verdict, deterministic flags, all signals+evidence,
      before→after weights, guardrail ceiling, outcome, rationaleHash + decisionURI
- [x] States: loading rows / empty / error (toggle via Demo states panel)

## 6. Agent `/agent` (§5.3, §14.5)
- [x] Identity card (ERC-8004 NFT: name, id, agentURI, owner, registry) + track record
- [x] "What I'm watching" watchlist: value vs threshold + status dot
- [x] Guardrails / "the limits" panel — immutable on-chain bounds
- [x] Ask-the-agent chat (bounded, read-only explanations, typing indicator)
- [x] States: loading skeleton / chat empty/typing/error

## 7. Insights `/insights` (§5.4, §14.6)
- [x] USDY NAV vs DEX price (peg) over time (de-risk dip marked)
- [x] Oracle range-end timeline (range-based wording, progress bar)
- [x] AUSD proof-of-reserves status (PoR ring)
- [x] Aave USDC utilization & APY
- [x] Data-table fallback per chart ("Show data table" toggle); "updated 12s ago" staleness pill

## 8. Modals (§6)
- [x] Deposit — amount input, caps surfaced, preview, Approve→Deposit stepper, tx state
- [x] Withdraw — USDC/shares toggle, preview, liquidity note, tx state
- [x] Transaction status — pending/confirmed/failed + mantlescan link + toast
- [x] Connect wallet (mock RainbowKit connectors), Network switch, Account (manage)
- [x] Modal rules: focus-trap, Esc, scroll-lock, aria-modal, return focus

## 9. Polish & verify (§9, §10, §12)
- [x] AI-interaction surfaces complete: agent status, plain-language rationale, typed evidence,
      confidence meter, guardrails-enforced mark, baseline counter, limits panel, watchlist, bounded chat
- [x] A11y: semantic landmarks, keyboard nav, visible focus rings, aria-modal/aria-live/aria-label,
      reduced-motion block, 44px+ touch targets (mobile tab bar), chart table fallbacks
- [x] Demo states control (§8 edge cases: paused / kill-switch / wrong-network / empty position / activity error)
- [x] Dark/light theme via `.app-root[data-theme]` wrapper (resolves env custom-property inheritance quirk)
- [x] Both themes verified; verifier agent forked
