# AGENTS.md — Operating Guide (canonical)

This file is the **single source of truth** for how any AI agent (Claude, Cursor,
Codex, etc.) or human contributor must work in this repository. `CLAUDE.md` and
`.cursor/rules/project.mdc` point here. **Before executing, read: `PLAN.md` (full
plan), `ROADMAP.md` (PR-sized per-phase tasks with What/Goal/Test), `SPEC.md`
(guardrail parameters, contract interfaces, Anthropic API prompt + risk-signal schema), and
`UI.md` (UI/UX plan). This file defines the rules you must follow while executing
them.**

If a request conflicts with these rules, **stop and ask** rather than silently
deviating.

---

## 1. What we are building (one paragraph)

**Sentinel** — an **AI risk-guardian real-yield account** on **Mantle**. Users
deposit **USDC**; an AI agent (powered by the **Anthropic API**) earns tokenized-Treasury
(**USDY**) yield with an **Aave v3** USDC floor for liquidity, and **autonomously
de-risks on-chain** into **AUSD**/USDC when RWA risk appears (depeg, oracle
staleness, issuer/regulatory shock) — **only within hard on-chain guardrails** —
recording every decision **and its triggering evidence** on-chain under an
**ERC-8004** identity. Target track: **AI × RWA, Application path**. The swap-to-
USDY is only the resting state; the **verifiable autonomous defense** is the
product. See `PLAN.md`.

---

## 2. Non-negotiable rules

1. **Data vs. execution boundary.** The **1delta API** may be used for **reading
   data** and **optional swap routing only**. It must **NEVER** be in the
   custody/execution path. The vault must **never execute arbitrary third-party
   calldata.** Execution happens only through our own audited adapters
   (`UsdyAdapter`, `AaveV3Adapter`, `AusdAdapter`) that call protocols/DEXs
   directly with on-chain `minOut`/guardrail checks.
2. **Guardrails are the final authority.** On-chain guardrails (see `SPEC.md` §1:
   max weight/bucket, min idle+Aave liquidity buffer, max slippage, token/venue
   whitelist, rebalance-frequency cap, per-tx caps, pause/kill switch, add-strategy
   timelock, depeg/oracle-deviation guard) are **immutable limits**. The AI
   **proposes**; a **deterministic validator** checks against guardrails **before
   signing**; the on-chain guardrails are the final backstop. The LLM may only
   **tighten** risk, never loosen it. On-chain `Guardrails` and the TS validator
   share constants from `packages/shared`. **Never** let the LLM be the only thing
   standing between funds and a bad action.
3. **AI only where it genuinely beats an algorithm.** Keep yield/optimization/peg/
   oracle/liquidity/execution **deterministic**. Use the LLM only for: unstructured→
   structured RWA risk signals, written rationale/explainability, judgment on novel
   events, and conversational UX. **No AI-washing.**
4. **Mantle-only.** Deploy on Mantle (chain ID **5000**). No other execution chains.
   (Solana/Byreal is explicitly out of scope.)
5. **Custody safety.** USDC is the only deposit asset. USDY and AUSD are sourced via
   **DEX, blocklist-aware** (USDY uses a blocklist transfer hook), never via
   KYC-gated mint in the vault path. **No leverage/looping** (no RWA market on
   Mantle supports it). The ALLOCATOR is a guardrail-bounded hot key with a working
   **kill switch**.
6. **Verify before integrating.** Treat every external address in `PLAN.md` as
   **unverified** until confirmed on-chain. Develop and test against `anvil --fork`
   of Mantle mainnet before deploying. The Phase-0 liquidity/oracle gates are
   mandatory.
7. **Ground-truth reads.** For assets the vault actually holds (Aave position,
   USDY NAV via `RWADynamicOracle`, USDY DEX price, AUSD proof-of-reserves), read
   **directly via RPC** as the accounting source of truth; 1delta is breadth/UX only.
8. **Secrets.** Never commit secrets (RPC keys, Anthropic API keys, 1delta API key,
   deployer/ALLOCATOR private keys, WalletConnect projectId if private). Use `.env`
   (git-ignored) + documented `.env.example`. Never log secrets.
9. **Scope & execution discipline (MoSCoW + ROADMAP).** Finish all **Must** items
   before any **Should**; **Should** before **Could**. Work in the PR-sized tasks
   defined in `ROADMAP.md`; **do not start a phase before the prior phase's exit
   criteria are met.** Feature-freeze target **2026-06-12**.
10. **Definition of done includes the submission bars.** A feature is not "done"
    until its `ROADMAP.md` Test passes and it moves us toward the §11 checklist in
    `PLAN.md` (deployed + verified + AI function on-chain + public demo +
    de-risk-event video + README).

---

## 3. Tech stack (do not substitute without asking)

- **Contracts:** Solidity + **Foundry** (forge, anvil, cast). Tests in Forge.
- **Frontend:** **React + Vite + Tailwind + daisyUI**; wallet via **RainbowKit +
  wagmi + viem**; reads via wagmi hooks, writes via viem. Clean/professional,
  purple accent, light+dark themes — see `UI.md`.
- **Backend/agent/API:** **Node.js + TypeScript + Fastify** + **viem** (no ethers).
- **TS tests:** **Vitest**.
- **Deploy:** **Docker** (backend + frontend) behind **Caddy** (or nginx) routing.
- **LLM:** **Anthropic API (Claude)**. **Data:** **1delta API** + **Mantle RPC**.

---

## 4. Repository conventions

- **Languages:** TypeScript (strict mode on) for all JS-land code; Solidity for
  contracts. No JavaScript source files.
- **Solidity:** explicit visibility, custom errors over revert strings, NatSpec on
  external/public functions, checks-effects-interactions, reentrancy guards on
  fund-moving functions. Prefer well-audited libraries (OpenZeppelin/Solmate).
  Match the interface sketches in `SPEC.md` §2 (refine as needed; keep names stable).
- **Naming:** contracts `PascalCase`; TS files `kebab-case`; React components
  `PascalCase`. Be descriptive.
- **Comments:** explain non-obvious intent/trade-offs/constraints only. Do **not**
  narrate what the code does. Never leave "explaining the change" comments.
- **Tests:** every contract that moves funds needs Forge tests on a Mantle fork
  (happy path + guardrail-violation + depeg/de-risk + liquidity-crunch withdrawal).
  Agent logic needs Vitest coverage for the risk engine + guardrail validator.
- **UI:** follow `UI.md` (tokens, two daisyUI themes, components, a11y). Build
  screens with typed mock data first, then wire to chain/agent.
- **Money math:** never trust floats for on-chain amounts; use bigint/fixed-point;
  always enforce `minOut`/slippage on swaps.

---

## 5. Git & workflow

- **Branches:** `cursor/<descriptive-name>-46a8`, lowercase. Stay on the working
  branch; do not switch branches unless asked.
- **Commits:** one logical change per commit, clear messages. Do not force-push or
  amend unless explicitly asked.
- **Push:** `git push -u origin <branch>`; retry network failures with backoff.
- **PRs:** open/update via the PR tool; default to draft. One PR per `ROADMAP.md`
  PR-group where practical. Keep `PLAN.md`, `ROADMAP.md`, `SPEC.md`, `UI.md`,
  `AGENTS.md`, `CLAUDE.md`, and the Cursor rule in sync when the plan changes.

---

## 6. When in doubt

- Re-read `PLAN.md` (strategy), `ROADMAP.md` (tasks/tests), `SPEC.md` (params &
  interfaces), `UI.md` (UI/UX), and this file (rules).
- If a decision isn't covered, pick the option that best protects **custody safety**
  and the **2026-06-12 freeze**, note it, and flag it.
- Anything touching guardrails, custody, the 1delta boundary, or scope → **ask
  first.**
