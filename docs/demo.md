# Custos — Demo Video Script & Production Plan

The submission demo video. Screen recording + voiceover is sufficient (no on-camera requirement).

- **Target length:** ~3:30 primary cut (hard floor 2:00). An **extended ~4:30–5:00 cut**
  (§8) adds the agent-economics / verifiable-job beats; a **30–60s vertical** (§8) is the
  community clip. No upper limit is imposed by the rules — keep the primary cut tight.
- **Format:** 1080p (1440p if crisp), 30fps, screen capture + clear voiceover.
- **Tone:** calm, factual, confidence-building (mirrors the product). No hype/emojis.
- **The one thing the video must land:** the **autonomous, AI-driven on-chain de-risk
  event** — the agent *reading fresh issuer evidence*, judging it dangerous, and defending
  funds **verifiably on-chain**, before any price-based threshold would have fired.
  Everything else supports that moment.

---

## 0. What the hero actually is (read this first)

The de-risk in this video is a **real, guardian-signed `deRisk()` (on-chain `kind=1`)**,
driven by the agent's **AI judgment over unstructured evidence** — not by a live peg break.
This matters for both honesty and for what appears on screen:

- The agent fetches a (staged) Ondo/USDY issuer disclosure, the **LLM judges** it a serious
  issuer event, the deterministic **guardrails validate**, and a **GUARDIAN** key signs the
  on-chain `deRisk()`. The triggering **document is synthetic**; the fetch, the AI judgment,
  the guardrail validation, and the on-chain de-risk are **all real**.
- Because it's a true `kind=1` de-risk, the UI shows the full payoff: Agent status flips to
  red **"De-risking,"** a **"De-risk"** entry appears in Activity, USDY collapses to 0% in
  the before→after bars, and the `DecisionRecorded(kind=1)` + `DeRisked` events land on
  mantlescan.
- **Why GUARDIAN and not the autonomous ALLOCATOR key?** An ALLOCATOR `deRisk()` reverts
  unless the on-chain peg/oracle guard has already tripped (`DeRiskConditionNotMet`). On a
  calm market the only signal is the off-chain document, which the chain can't verify — so
  the contract refuses to stamp an ALLOCATOR move as `kind=1`. The **GUARDIAN** role is the
  sanctioned discretionary escape hatch (it may de-risk on judgment without a breach). This
  is the strength of the story, not a workaround: the **deterministic guards watch
  peg/oracle/liquidity; the AI adds judgment over issuer/regulatory evidence no threshold
  can capture.** Narrate the de-risk as "the agent defends"; disclose the synthetic doc.

Run it with one command at record time (full setup + tuning in §4):

```bash
# rehearse (no tx): AI verdict + route + pin, but DON'T send
ANTHROPIC_API_KEY=… DEMO_DERISK_EVIDENCE_URL=… pnpm -C agent demo:derisk --dry
# the on-camera event: judge + send the real on-chain deRisk()
ANTHROPIC_API_KEY=… DEMO_DERISK_EVIDENCE_URL=… GUARDIAN_PRIVATE_KEY=… pnpm -C agent demo:derisk
```

---

## 1. Pre-flight checklist (record only when all true)

**Chain / contracts**
- [ ] Contracts deployed + **verified on mantlescan** (have the tab ready).
- [ ] ERC-8004 identity registered; `VITE_AGENT_ID` set so the Agent identity card is live.
- [ ] Vault has **a few past decisions** seeded so Activity isn't empty.
- [ ] **USDY position seeded to ~40–45%** (via `pnpm -C agent rebalance …` or the Allocator
      page) — small absolute USDY notional so the thin-pool sell clears the 0.5% oracle-NAV
      `minOut` at peg. The de-risk needs USDY > 0 to have something to rotate out of.

**De-risk trigger (the hero)**
- [ ] **GUARDIAN key holds the GUARDIAN role** on the vault and has **MNT gas**
      (`demo:derisk` pre-flights `hasRole` and aborts with a grant hint if not).
- [ ] Staged evidence page deployed + reachable at
      `https://trycustos.xyz/demo/derisk-evidence.html`; `DEMO_DERISK_EVIDENCE_URL` points
      at it.
- [ ] **IPFS configured** (`IPFS_API_URL` + `IPFS_PINNING_JWT`) so the on-chain decision
      bundle resolves to a clickable URL on camera (else it's an inline `data:` URI).
- [ ] `pnpm -C agent demo:derisk-dryrun` returns **PASS** (clamped `deRisk:true`, trusted
      citation). Then `pnpm -C agent demo:derisk --dry` succeeds end-to-end (route + pin).

**Frontend**
- [ ] Public frontend URL live (not localhost); **both themes** working.
- [ ] `VITE_AGENT_API_URL` set so the live snapshot drives **"What I'm watching,"** the
      peg/oracle/APY metrics, and **"Ask the agent"** (`/ask`); confirm a question answers.
- [ ] Demo wallet funded with USDC on Mantle; gas (MNT) available.
- [ ] *(optional)* Seed one AgentBenchmark outcome so the "Custos vs passive" widget shows
      real numbers — otherwise it reads zeroed in live mode; don't dwell on it if so.

**Capture**
- [ ] Browser zoom ~110–125%, clean profile (no clutter/extensions bar), notifications off.
- [ ] Script + timer on a second screen; mantlescan + the IPFS bundle + the staged evidence
      page pre-opened in tabs.

---

## 2. Shot list (with voiceover)

> VO = voiceover · SCR = on-screen action · CUT = cutaway/overlay · TXT = on-screen caption

### 0:00–0:05 — Brand cold open
- **SCR:** `web/public/custos.mp4` as a **≤4s** sting (trim/speed to taste); logo → wordmark.
- **VO:** *(none, or a single word as the wordmark lands)* "Custos."

### 0:05–0:22 — Hook (the problem)
- **VO:** "Tokenized US Treasuries pay real yield on-chain — but holding them blind is
  risky. Pegs slip, oracles stall, and issuers and regulators move faster than any price
  feed. Most people can't watch all of that. Custos can."
- **SCR:** Landing/dashboard hero in **dark** theme; a slow scroll showing the clean UI.

### 0:22–0:42 — What it is + connect
- **VO:** "Custos is an AI risk-guardian real-yield account on Mantle. You deposit USDC; it
  earns Treasury yield through USDY, keeps a liquid Aave floor, and an autonomous agent
  defends your money on-chain — proving every move."
- **SCR:** Click **Connect wallet** → RainbowKit modal → connected; the network pill shows
  **Mantle**.

### 0:42–1:05 — Deposit
- **VO:** "Depositing is one flow. Approve, deposit USDC, and you receive vault shares —
  inside hard, on-chain guardrails, with a per-transaction cap."
- **SCR:** Deposit modal → enter amount → preview (shares out, share price, projected
  blended APY, vault capacity) → Approve → Deposit → success toast → dashboard updates
  (position value + allocation donut + instant-liquidity floor).

### 1:05–1:30 — Dashboard tour
- **VO:** "Here's the whole position at a glance: your value and blended yield, and the live
  vault allocation — Treasuries, the Aave floor, and a cash buffer that keeps a share
  instantly withdrawable. And it's benchmarked: Custos versus simply holding USDY."
- **SCR:** Pan the dashboard — Position card, Allocation donut (USDY / Aave / idle, with the
  RWA form split), the instant-withdrawable floor chip, and the **"Custos vs passive USDY"**
  card (sparkline, drawdown-avoided). Glance at Vault stats: **USDY peg gauge** + **oracle
  valid**.
- **TXT:** *(if the benchmark widget is zeroed live)* keep it brief / skip the number.

### 1:30–1:55 — The agent: what it watches & the limits it can't cross
- **VO:** "The agent is always visible. Here's exactly what it watches in real time — USDY's
  peg versus its Treasury value, oracle freshness, Aave liquidity, AUSD reserves. And here
  are the limits it can never cross: immutable, on-chain guardrails. The model proposes;
  these dispose. It is never the last line of defense."
- **SCR:** Go to **Agent** → **"What I'm watching"** (live rows, thresholds, all Normal) →
  **"The limits · on-chain guardrails"** (Immutable badge; max USDY weight, slippage, move
  size, peg thresholds…).

### 1:55–2:42 — HERO: the autonomous, AI-driven de-risk
- **VO:** "Now the part that matters. A fresh issuer disclosure hits the agent's evidence
  feed — a redemption halt at the USDY issuer, with reserves it can't verify. Notice the
  peg and oracle are still calm, so a threshold-based system would still be holding. But the
  agent **reads** the disclosure, **judges** it too risky to keep, and rotates the entire
  USDY position into USDC — instantly liquid — recording the decision, and its evidence,
  on-chain."
- **SCR:** Trigger `pnpm -C agent demo:derisk` (optionally inset the terminal: the model's
  rationale + "AI judged a trusted, cited de-risk" + the tx hash). Cut to the **live UI
  reacting**: Agent status flips to red **"De-risking"** → Allocation donut: **USDY → 0**,
  USDC up → **Activity** shows a new **"De-risk"** entry → open it: risk verdict **DERISK**,
  **before→after** bars (USDY collapses), then click **Decision bundle** to reveal the AI's
  rationale + the cited issuer evidence (pinned to IPFS).
- **CUT:** Click the tx → **mantlescan**: the `DecisionRecorded(kind=1)` + `DeRisked` events.
  "Verifiable, on Mantle."
- **TXT (hold ~3s):** "Triggering document is synthetic. The AI judgment, guardrail
  validation, and on-chain de-risk are real. De-risk is guardian-signed on the agent's
  recommendation."

### 2:42–3:00 — Explain it, then prove the identity
- **VO:** "And you can ask it why — in plain language, read-only; it never takes orders from
  chat. The agent itself has an on-chain identity: an ERC-8004 NFT building a verifiable
  track record — decisions made, de-risk events handled."
- **SCR:** **Ask the agent** → "Why did you exit USDY?" → grounded answer (cites the issuer
  evidence). Then the **Identity card** (ERC-8004 NFT, owner, registry, agent card link);
  the **De-risk events** count has ticked up by the move you just made.

### 3:00–3:18 — Withdraw & liquidity
- **VO:** "Withdrawals are served from the instant-liquidity buffer first, so you're not
  waiting on Treasury markets to exit."
- **SCR:** Withdraw modal → preview + the instant-liquidity note → confirm → funds back,
  position updates.

### 3:18–3:35 — Close
- **VO:** "Real yield, autonomously defended, fully transparent — built on Mantle.
  Open-source, deployed, and live."
- **SCR:** Final dashboard; flip **light** theme briefly. End card overlay (hold ~3s):
  **contract address + mantlescan link + repo URL + live demo URL**. *(Optional: a 2–3s
  `custos.mp4` outro slice under the end card.)*

---

## 3. Full voiceover script (clean read)

> Read at ~140 wpm; pause on the de-risk moment. **Keep the model unnamed** — say "the
> agent" / "its AI," not a specific model (see §5).

1. *(Cold open — optional single word)* "Custos."
2. "Tokenized US Treasuries pay real yield on-chain — but holding them blind is risky. Pegs
   slip, oracles stall, and issuers and regulators move faster than any price feed. Most
   people can't watch all of that. Custos can."
3. "Custos is an AI risk-guardian real-yield account on Mantle. You deposit USDC; it earns
   Treasury yield through USDY, keeps a liquid Aave floor, and an autonomous agent defends
   your money on-chain — proving every move."
4. "Depositing is one flow. Approve, deposit USDC, and you receive vault shares — inside
   hard, on-chain guardrails, with a per-transaction cap."
5. "Here's the whole position at a glance: your value and blended yield, and the live vault
   allocation — Treasuries, the Aave floor, and a cash buffer that keeps a share instantly
   withdrawable. And it's benchmarked: Custos versus simply holding USDY."
6. "The agent is always visible. Here's exactly what it watches in real time — USDY's peg
   versus its Treasury value, oracle freshness, Aave liquidity, AUSD reserves. And here are
   the limits it can never cross: immutable, on-chain guardrails. The model proposes; these
   dispose. It is never the last line of defense."
7. "Now the part that matters. A fresh issuer disclosure hits the agent's evidence feed — a
   redemption halt at the USDY issuer, with reserves it can't verify. Notice the peg and
   oracle are still calm, so a threshold-based system would still be holding. But the agent
   reads the disclosure, judges it too risky to keep, and rotates the entire USDY position
   into USDC — instantly liquid — recording the decision, and its evidence, on-chain."
8. "And you can ask it why — in plain language, read-only; it never takes orders from chat.
   The agent itself has an on-chain identity: an ERC-8004 NFT building a verifiable track
   record — decisions made, de-risk events handled."
9. "Withdrawals are served from the instant-liquidity buffer first, so you're not waiting on
   Treasury markets to exit."
10. "Real yield, autonomously defended, fully transparent — built on Mantle. Open-source,
    deployed, and live."

---

## 4. Triggering the hero de-risk (the chosen mechanism)

**Mechanism: guardian-signed `deRisk()` on the agent's AI judgment** — `agent/src/scripts/
demoDeRisk.ts` (`pnpm -C agent demo:derisk`). It runs the same evidence → LLM verdict as the
dry-run and, when the model returns a clamped `deRisk:true` citing a trusted source, submits
a real on-chain `deRisk(toBucket=IDLE)` signed by the **GUARDIAN** key — recording a true
`kind=1` de-risk on calm mainnet (no fork, no pool nudge). See §0 for why this is the right,
honest path.

**Setup (one-time):**
- Host the staged page (committed at [`web/public/demo/derisk-evidence.html`](../web/public/demo/derisk-evidence.html))
  — served at `https://trycustos.xyz/demo/derisk-evidence.html`. Its `<title>` +
  `<meta name="description">` carry the cited threat (a redemption halt / unverifiable
  reserves); the agent reads only those two tags.
- Set `DEMO_DERISK_EVIDENCE_URL` to that page. The evidence fetcher swaps the curated
  `ondo-usdy-attestation` feed's URL to it, keeping `id`/`type`/`source` so it stays
  de-risk-eligible (N2). Unset = zero behaviour change.
- Provision a **GUARDIAN key**: `GUARDIAN_PRIVATE_KEY` (kept *separate* from the allocator
  hot key) that holds `Roles.GUARDIAN` on the vault and has MNT for gas. Grant from admin:
  `vault.grantRole(keccak256("GUARDIAN"), <guardianAddr>)`. The script pre-flights `hasRole`
  and aborts with the exact grant call if it's missing.
- Configure **IPFS** (`IPFS_API_URL` + `IPFS_PINNING_JWT`) so the pinned decision bundle is
  gateway-resolvable on camera.

**Vault pre-stage:** keep **USDY at ~40–45%** with a small absolute notional, so the thin-
pool USDY→USDC sell clears the 0.5% oracle-NAV `minOut` at peg. (Seed via `pnpm -C agent
rebalance <idle> <aave> <usdy> <ausd>` or the Allocator page.)

**Pre-flight before filming (tune until reliable; temp is 0.1):**
```bash
ANTHROPIC_API_KEY=… DEMO_DERISK_EVIDENCE_URL=… pnpm -C agent demo:derisk-dryrun   # PASS = AI will de-risk
ANTHROPIC_API_KEY=… DEMO_DERISK_EVIDENCE_URL=… GUARDIAN_PRIVATE_KEY=… pnpm -C agent demo:derisk --dry   # route + pin, no tx
```
If the dry-run says the model "held," strengthen the staged document's title/description.

**Film the event:**
```bash
ANTHROPIC_API_KEY=… DEMO_DERISK_EVIDENCE_URL=… GUARDIAN_PRIVATE_KEY=… pnpm -C agent demo:derisk
```
The script prints the model rationale, pins the bundle, builds the USDY→USDC route, sends
`deRisk()`, and prints the tx + `mantlescan` URL.

**What appears in the UI (verify each on camera):**
- **Dashboard → Agent status:** flips to red **"De-risking"** (keys off the new
  `kind=1`/DERISK decision).
- **Dashboard → Allocation:** USDY slice → **0**; idle/USDC rises.
- **Activity:** a new top **"De-risk"** entry — DERISK chip, USDY→0 before→after bars,
  on-chain tx chip, rationale hash. The **inline** signals/evidence are intentionally empty
  for live decisions; the full AI rationale + cited evidence live in the **Decision bundle**
  (IPFS) — open it to show them. *(Optionally also open the staged evidence page itself.)*
- **Agent → Identity:** the **De-risk events** counter increments (live, on-chain).
- **mantlescan:** the de-risk tx shows `DecisionRecorded(id, kind=1, …)` + `DeRisked(id,
  toBucket, evidenceHash)`.
- **"What I'm watching"** stays green — say so: this de-risk came from *evidence the AI
  read*, not a market metric. That's the differentiator.

**Disclose honestly (on-camera caption + once in VO):** the triggering document is synthetic;
the fetch, the AI judgment, the guardrail validation, and the on-chain de-risk are real; the
de-risk is guardian-signed on the agent's recommendation.

**After filming:** unset `DEMO_DERISK_EVIDENCE_URL`; rebalance back into USDY for re-takes
(`pnpm -C agent rebalance …`). Always show the resulting **on-chain** tx on mantlescan.

---

## 5. Production notes

- **Tool:** OBS (or similar); record clean segments, edit in CapCut/DaVinci/iMovie.
- **`custos.mp4` intro/outro:** use `web/public/custos.mp4` as a **≤4s** branded cold open
  (trim/speed up); optionally reuse a 2–3s slice under the end card. Keep VO off the sting.
- **Name no model.** The demo runs on an Anthropic-compatible endpoint (z.ai GLM) for cost;
  the codebase targets Anthropic Claude. Keep narration model-agnostic — "the agent," "its
  AI," "the model" — so nothing on camera is inaccurate either way.
- **Pacing:** trim dead air; speed up tx-confirmation waits (1.5–2×) but keep the mantlescan
  reveal and the decision-bundle reveal at normal speed.
- **Captions:** burn-in captions (accessibility + sound-off viewing) — reusable for the
  community clip. The synthetic-document disclosure must be a readable on-screen caption.
- **Music:** optional, very low, neutral; never over the VO.
- **Cursor:** highlight clicks; avoid frantic mouse movement.
- **Two-theme flash:** show light + dark briefly (the toggle is in the top bar).
- **End card:** static frame with all links (contract, mantlescan, repo, live demo), ~3s.

---

## 6. Contingencies

- **Model "holds" (no de-risk) at record time:** it's a wording issue — strengthen the
  staged document's `<title>`/`<meta description>` and re-run `demo:derisk-dryrun` until it
  PASSes. (A non-zero exit from the dry-run distinguishes an infra/API error from a genuine
  hold.)
- **`deRisk()` reverts `DeRiskConditionNotMet` / `NotAllocatorOrGuardian`:** the signer
  isn't GUARDIAN — grant the role (the script prints the exact `grantRole` call).
- **Thin-pool `minOut` revert:** USDY notional too large — reduce the seeded USDY position
  and retry.
- **Decision bundle shows a `data:` URI (not clickable):** IPFS isn't configured — set
  `IPFS_API_URL` + `IPFS_PINNING_JWT` and re-run.
- **RPC/UI hiccup:** pre-record each segment separately; stitch in edit.
- **Never fake a tx.** If the live event won't cooperate, fix the cause above — always land a
  real on-chain decision on mantlescan.

---

## 7. Submission alignment

- ✅ ≥2-min walkthrough of the core use case (deposit → manage → **de-risk** → withdraw).
- ✅ Shows a **deployed, verified** contract + an **AI function callable on-chain** (the
  agent's AI judgment driving a real `deRisk()`).
- ✅ Shows the **public** frontend URL (both themes).
- ✅ Surfaces deployment address + repo for the description (end card + footer links).

---

## 8. Extended cut & community clip (Should)

**Extended cut (~4:30–5:00)** — same spine, plus the agent-as-economic-actor beats (all
*outside* the vault custody path):
- **Agent economics · x402** (Agent page): the agent **sells** its risk score per call and
  **pays** for premium evidence via x402 — settled entirely outside custody. Show the
  `/risk-score` paid endpoint + an x402 paid-evidence badge on a decision.
- **Verifiable job · ERC-8183** (Activity → decision detail): the de-risk modelled as an
  escrowed Job whose **Evaluator is the deterministic guardrail check** — released only
  because the de-risk was guardrail-justified, feeding **ERC-8004 reputation**.
- **Allocator (manual seed):** the ALLOCATOR sets a target allocation in a single,
  guardrail-validated, simulated `rebalance()` — how the RWA position is seeded.

**Community vertical (30–60s)** for X/Twitter (Community Voting): hook (0–5s) → the de-risk
moment (5–35s) → one-line value + link (35–55s). Captions burned in; same footage, tighter
edit; lead with the red "De-risking" flip and the mantlescan reveal.
