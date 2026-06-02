# Sentinel — Community & Marketing Assets (ROADMAP 6.5)

Draft copy for Community Voting and launch. All assets reference **real deployed
contracts**; fill in `[PUBLIC_URL]`, `[MAINNET_CONTRACT]`, and `[VIDEO_URL]` once
5.2 + 6.1 are live.

---

## 1. X (Twitter) launch thread

> Post as a thread. Keep images/screenshots attached to the relevant tweet. Burn-in
> captions on any video clips. Use the community-cut clip (§3) on tweet 1.

---

**Tweet 1 — Hook (attach community-cut clip)**

> I built an AI that defends your tokenized-Treasury yield on Mantle — autonomously,
> verifiably, on-chain.
>
> Deposit USDC → earn USDY yield → agent detects RWA danger → rotates to safety
> before damage lands → writes the proof on-chain.
>
> Not a chatbot. An on-chain autonomous risk guardian.
>
> Thread 🧵 1/8

---

**Tweet 2 — The problem (attach: peg-deviation chart screenshot)**

> Tokenized US Treasuries pay real yield — but holding them blind is risky.
>
> Pegs slip. Oracles go stale. Issuers and regulators act fast.
>
> By the time you notice, the damage is done.
>
> Sentinel watches 24/7. 2/8

---

**Tweet 3 — How it works (attach: dashboard screenshot)**

> Deposit USDC. Sentinel allocates across:
>
> 🏦 Ondo USDY — tokenized Treasury yield  
> 🏦 Aave v3 — instant-liquidity floor  
> 🛡️ Agora AUSD — reserve-backed safety bucket
>
> Every allocation bounded by **immutable on-chain guardrails** the AI can never
> override.
>
> 3/8

---

**Tweet 4 — The AI's actual role (attach: activity-feed screenshot with de-risk)**

> The AI (Anthropic Claude) reads what thresholds miss:
> attestation PDFs, issuer news, redemption-pause headlines.
>
> It **proposes** a de-risk. A deterministic validator **checks** it.
> Immutable on-chain guardrails are the **final backstop**.
>
> The model is never the last line of defense. 4/8

---

**Tweet 5 — The hero moment (attach: mantlescan tx screenshot)**

> When the guardrail trips:
>
> → USDY rotated to AUSD/USDC
> → `DecisionRecorded` event on-chain with IPFS evidence bundle
> → `AgentBenchmark` writes the bps delta vs a passive USDY holder
> → Every step **verifiable by anyone**
>
> Here's the tx: [MANTLESCAN_LINK] 5/8

---

**Tweet 6 — Verifiability features (attach: agent identity card + ERC-8183 job chip)**

> What makes it trustworthy, not just a "trust us":
>
> ✅ ERC-8004 on-chain agent identity + reputation
> ✅ ERC-8183 job escrow — guardrail IS the evaluator, not the LLM
> ✅ x402 paid evidence — the agent paid for what it acted on
> ✅ `AgentBenchmark` — on-chain proof it beats passive USDY
>
> 6/8

---

**Tweet 7 — Stack / Mantle-specific (attach: architecture ASCII or architecture screenshot)**

> Fully on Mantle (5000). Built with:
>
> • Ondo USDY/mUSD + RWADynamicOracle
> • Agora AUSD + Chaos Labs PoR
> • Aave v3 (Mantle)
> • Odos aggregator (pinned, oracle-derived minOut — not trusted calldata)
> • Canonical ERC-8004 singletons on Mantle
>
> Contracts: [PUBLIC_URL] | Repo: github.com/0xMaxyz/miu 7/8

---

**Tweet 8 — CTA**

> Try it, read the contracts, watch it de-risk.
>
> 🔗 Live app: [PUBLIC_URL]
> 📜 Contracts: [MAINNET_CONTRACT] (mantlescan)
> 🎬 Video: [VIDEO_URL]
> 💻 Source: github.com/0xMaxyz/miu
>
> AI × RWA × Mantle. 8/8

---

## 2. Screenshots to capture

Capture at 1440×900 (or 2× for retina). Clean browser profile, Mantle mainnet, a
seeded vault with a few past decisions. Both themes; prefer dark for social, light for
the PR submission.

| # | Screen | What to show | File name |
|---|--------|-------------|-----------|
| 1 | Dashboard (dark) | Connected wallet, position with USDY/mUSD/Aave/AUSD allocation donut, blended APY, baseline counter above 0 | `screenshot-dashboard-dark.png` |
| 2 | Dashboard (light) | Same view, light theme | `screenshot-dashboard-light.png` |
| 3 | Activity feed | ≥2 decisions visible; one De-risk item with risk-level chip and before→after bars | `screenshot-activity-feed.png` |
| 4 | De-risk detail modal | Full decision modal: rationale text, evidence chips, ERC-8183 job chip, paid-evidence badge, before→after | `screenshot-derisk-detail.png` |
| 5 | Agent page | Identity card (ERC-8004 NFT), agent economics panel (x402 sells, jobs ledger), watchlist | `screenshot-agent-page.png` |
| 6 | Insights page | Peg-deviation chart with de-risk dip marked, oracle freshness bar, AUSD PoR ring | `screenshot-insights-derisk.png` |
| 7 | Mantlescan | `DecisionRecorded` event + decoded fields on the de-risk tx | `screenshot-mantlescan-event.png` |
| 8 | Mantlescan — contract | Verified Guardrails or YieldVault contract page (source tab visible) | `screenshot-mantlescan-verified.png` |

**Capture tips:**
- Zoom browser to 110–125%; hide extensions bar.
- Use the Demo-states panel (§8 of DEMO.md) to seed a de-risk state cleanly without
  needing a live mainnet event for screenshots.
- For screenshot 7, trigger a real `deRisk` on testnet first and screenshot that tx
  (testnet mantlescan also counts for the screenshot).

---

## 3. Community-cut clip (30–60 s vertical, for Tweet 1)

> 9:16 aspect, 1080×1920. Burned-in captions. Same footage as the full demo video
> (DEMO.md), just cut tight. Export at ~15 MB so it uploads natively to X.

**Shot list:**

| Time | Visual | Caption |
|------|--------|---------|
| 0–4 s | Dashboard hero (dark theme), vault position visible | "Your USDC. Earning Treasury yield. Protected by AI." |
| 4–9 s | Allocation donut spinning in; USDY + mUSD + Aave + AUSD labels | "Allocated across tokenized Treasuries, Aave, and a safety reserve." |
| 9–20 s | HERO: Agent status flips → "De-risking" → Activity feed → new De-risk item appears | "USDY peg drops below NAV. The agent detects it." |
| 20–30 s | Open de-risk decision modal: rationale text, evidence chips, ERC-8183 job chip | "Rotates to AUSD — automatically. Decision written on-chain with evidence." |
| 30–38 s | Mantlescan reveal: DecisionRecorded event with decoded fields | "Verifiable. On Mantle." |
| 38–48 s | Agent page: ERC-8004 identity card + baseline counter ticking up | "The agent has an on-chain identity and a benchmark. Judge it yourself." |
| 48–58 s | End card: live URL + contract + repo, dark → brief light theme flash | "Live on Mantle · github.com/0xMaxyz/miu" |

**Edit notes:**
- Speed up wallet-connect and tx-confirm waits (1.5–2×); keep mantlescan reveal at 1×.
- Fade-in captions 0.2 s; hold full text width on left side (safe zone 5% from edges).
- No music, or very low instrumental at −24 dB. Never over the captions.
- Export: H.264, AAC 128 k, max 60 fps. Target ≤ 50 MB for native X upload.

---

## 4. Alt text / accessibility copy

Use these when uploading screenshots. **Numbers below are illustrative** — match them
to whatever the Demo-states panel actually seeds when you capture, so the alt text never
reads as a misleading live metric.

| File | Alt text |
|------|----------|
| `screenshot-dashboard-dark.png` | Example: Sentinel dashboard showing USDC position, blended APY, allocation donut (USDY 35 % / Aave 40 % / AUSD 15 % / IDLE 10 %), and baseline counter: Sentinel +18 bps vs passive USDY holder |
| `screenshot-activity-feed.png` | Sentinel Activity feed showing two decisions: a Rebalance and a De-risk event with risk-level chip, before/after allocation bars, and an evidence chip |
| `screenshot-derisk-detail.png` | De-risk decision detail modal: AI rationale text, peg-deviation evidence chip, ERC-8183 job status chip (Completed), paid-evidence badge, before→after allocation weights |
| `screenshot-agent-page.png` | Sentinel Agent page showing ERC-8004 identity NFT card, agent economics panel with x402 risk-score sales and ERC-8183 job ledger |
| `screenshot-mantlescan-event.png` | Mantlescan transaction page showing DecisionRecorded event with decoded rationaleHash and decisionURI fields |

---

## 5. DoraHacks submission blurb (Community Voting description)

> **Sentinel** is an AI risk-guardian real-yield account on Mantle. Deposit USDC; the
> agent earns tokenized-Treasury (USDY) yield across four allocation buckets, and
> **autonomously de-risks on-chain** when RWA danger appears — writing every decision
> and its evidence under a verifiable ERC-8004 identity.
>
> The key insight: **the verifiable autonomous defense, not the swap-to-USDY, is the
> product.** The AI (Anthropic Claude) reads attestation PDFs and headlines that
> thresholds miss; a deterministic validator checks; immutable on-chain Guardrails
> backstop. The model is never the last line of defense.
>
> Built on Ondo USDY/mUSD + RWADynamicOracle, Agora AUSD, Aave v3, Odos, and the
> canonical ERC-8004 singletons — exclusively on Mantle.
>
> - Live app: [PUBLIC_URL]
> - Source: github.com/0xMaxyz/miu
> - Demo: [VIDEO_URL]
> - Deployed: [MAINNET_CONTRACT] (mantlescan)
