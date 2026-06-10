# Custos — Demo Video Script & Production Plan

The submission demo video. Screen recording + voiceover is sufficient (no on-camera requirement).

- **Target length:** ~2:45 (hard floor 2:00).
- **Format:** 1080p (1440p if crisp), 30fps, screen capture + clear voiceover.
- **Tone:** calm, factual, confidence-building (mirrors the product). No hype/emojis.
- **The one thing the video must land:** the **autonomous on-chain de-risk event** —
  the agent detecting an RWA risk and defending funds, verifiably. Everything else
  supports that moment.

---

## 1. Pre-flight checklist (record only when all true)

- [ ] Contracts deployed + **verified on mantlescan** (have the tab ready).
- [ ] Public frontend URL live (not localhost); both themes working.
- [ ] Demo wallet funded with USDC on the target network; gas (MNT) available.
- [ ] Vault already has **a few past decisions** seeded so the Activity feed isn't empty.
- [ ] A **reproducible risk event** ready to trigger (see §4 + §6 contingency).
- [ ] ERC-8004 identity registered; identity card populated.
- [ ] Browser zoom ~110–125%, clean profile (no clutter/extensions bar), notifications off.
- [ ] Script + timer on a second screen; mantlescan + IPFS links pre-opened.

---

## 2. Shot list (with voiceover)

> VO = voiceover · SCR = on-screen action · CUT = cutaway/overlay

### 0:00–0:15 — Hook (the problem)
- **VO:** "Tokenized US Treasuries pay real yield on-chain — but holding them blind
  is risky: pegs slip, oracles stall, issuers and regulations change. Most people
  can't watch all of that. Custos can."
- **SCR:** Landing/dashboard hero in dark theme; subtle scroll showing the clean UI.

### 0:15–0:35 — What it is
- **VO:** "Custos is an AI risk-guardian real-yield account on Mantle. You deposit
  USDC; it earns Treasury yield through USDY, keeps a liquid Aave floor, and an
  autonomous agent defends your money on-chain — proving every move."
- **SCR:** Connect wallet (RainbowKit modal → connected), network pill shows Mantle.

### 0:35–1:00 — Deposit
- **VO:** "Depositing is one flow. Approve, deposit USDC, and you receive vault
  shares. The agent puts the capital to work across Treasuries, Aave, and a cash
  buffer — within hard on-chain guardrails."
- **SCR:** Open Deposit modal → enter amount → preview (shares, APY) → Approve →
  Deposit → success toast → dashboard updates (position + allocation donut).

### 1:00–1:25 — Dashboard & transparency
- **VO:** "Here's the whole position at a glance: your value, blended yield, and the
  live allocation. The agent's status is always visible — right now it's monitoring,
  and here's exactly what it's watching: USDY's peg versus its Treasury value, oracle
  freshness, Aave liquidity."
- **SCR:** Dashboard tour → Agent Status card → `/agent` "What I'm watching" panel
  with live thresholds.

### 1:25–2:05 — HERO: the autonomous de-risk
- **VO:** "Now watch what makes this different. USDY's market price drops below its
  Treasury value — a depeg. The agent detects it, and because the deviation crosses
  the guardrail, it automatically rotates out of USDY into USDC — instantly liquid
  and safe — and writes the decision on-chain."
- **SCR:** Trigger the event (§4) → Agent status flips to **De-risking** (amber/red)
  → Activity feed shows a new **De-risk** entry appearing → open the decision:
  plain-language rationale + **evidence chips** (peg reading, source) + before→after
  allocation bars.
- **CUT:** click the tx → **mantlescan** showing the on-chain `deRisk` / `Decision`
  event. "Verifiable, on Mantle."

### 2:05–2:25 — Identity & benchmark (the defining features)
- **VO:** "Every decision is benchmarked on-chain, and the agent itself has an
  on-chain identity — an ERC-8004 NFT that builds a verifiable track record of how
  well it manages risk over time."
- **SCR:** `/agent` Identity card → ERC-8004 NFT + track record (decisions, de-risk
  events handled, realized yield). CUT to the registry/identity on mantlescan.

### 2:25–2:40 — Withdraw & liquidity
- **VO:** "Withdrawals are served from the instant-liquidity buffer first, so you're
  not waiting on Treasury markets to exit."
- **SCR:** Withdraw modal → preview + liquidity note → confirm → funds back, position
  updates.

### 2:40–2:50 — Close
- **VO:** "Real yield, autonomously defended, fully transparent — built on Mantle.
  Open-source, deployed, and live."
- **SCR:** Final dashboard; overlay card: **contract address + mantlescan link +
  repo URL + live demo URL**. Light-theme flash to show theming.

---

## 3. Full voiceover script (clean read)

> Read at ~140 wpm; pause on the de-risk moment.

1. "Tokenized US Treasuries pay real yield on-chain — but holding them blind is
   risky: pegs slip, oracles stall, issuers and regulations change. Most people
   can't watch all of that. Custos can."
2. "Custos is an AI risk-guardian real-yield account on Mantle. You deposit USDC;
   it earns Treasury yield through USDY, keeps a liquid Aave floor, and an autonomous
   agent defends your money on-chain — proving every move."
3. "Depositing is one flow. Approve, deposit USDC, and you receive vault shares. The
   agent puts the capital to work across Treasuries, Aave, and a cash buffer — within
   hard on-chain guardrails."
4. "Here's the whole position at a glance: your value, blended yield, and the live
   allocation. The agent's status is always visible — right now it's monitoring, and
   here's exactly what it's watching: USDY's peg versus its Treasury value, oracle
   freshness, Aave liquidity."
5. "Now watch what makes this different. USDY's market price drops below its Treasury
   value — a depeg. The agent detects it, and because the deviation crosses the
   guardrail, it automatically rotates out of USDY into USDC — instantly liquid and
   safe — and writes the decision on-chain."
6. "Every decision is benchmarked on-chain, and the agent itself has an on-chain
   identity — an ERC-8004 NFT that builds a verifiable track record of how well it
   manages risk over time."
7. "Withdrawals are served from the instant-liquidity buffer first, so you're not
   waiting on Treasury markets to exit."
8. "Real yield, autonomously defended, fully transparent — built on Mantle.
   Open-source, deployed, and live."

---

## 4. Triggering the hero de-risk event

Pick the most reliable available at record time:
1. **Real, controlled:** if a small mainnet test pool lets us nudge USDY spot below
   NAV beyond `pegDeRiskBps`, do it for real and capture the agent reacting.
2. **Testnet/fork scenario:** run the same agent against a fork where we set the DEX
   spot below the oracle NAV; record the detection → on-chain `deRisk`.
3. **Deterministic replay:** a "scenario mode" that feeds a recorded depeg snapshot
   to the agent so the on-chain decision fires on demand (clearly the same code path;
   data is staged, logic is real).

Always show the resulting **on-chain** tx on mantlescan so it's verifiable.

---

## 5. Production notes

- **Tool:** OBS (or similar); record clean segments, edit in CapCut/DaVinci/iMovie.
- **Pacing:** trim dead air; speed up tx-confirmation waits (1.5–2×) but keep the
  mantlescan reveal at normal speed.
- **Captions:** burn-in captions (accessibility + sound-off viewing) — also reusable
  for the community clip.
- **Music:** optional, very low, neutral; never over the VO.
- **Cursor:** highlight clicks; avoid frantic mouse movement.
- **Two-theme flash:** show light + dark briefly.
- **End card:** static frame with all links, held ~3s.

---

## 6. Contingencies

- **De-risk won't trigger live:** fall back to §4 option 3 (scenario replay) — never
  fake a tx; always land a real on-chain decision.
- **RPC/UI hiccup:** pre-record each segment separately; stitch in edit.
- **Mainnet not ready by record day:** record on testnet, clearly labelled; still
  satisfies the award (testnet allowed) — but prefer mainnet for credibility.

---

## 7. Submission alignment

- ✅ ≥2-min walkthrough of the core use case (deposit → manage → **de-risk** →
  withdraw).
- ✅ Shows a **deployed, verified** contract + an **AI function callable on-chain**.
- ✅ Shows the **public** frontend URL.
- ✅ Surfaces deployment address + repo for the description.

---

## 8. Community cut (Should)

A **30–60s vertical** clip for X/Twitter (Community Voting): hook (0–5s) → the
de-risk moment (5–35s) → one-line value + link (35–55s). Captions burned in; same
footage, tighter edit.
