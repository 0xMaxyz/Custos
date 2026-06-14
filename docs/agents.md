# agents.md — Operating Guide (canonical)

This file is the **single source of truth** for how any AI agent (Claude, Cursor,
Codex, etc.) or human contributor must work in this repository. `CLAUDE.md` and
`.cursor/rules/project.mdc` point here. **Before executing, read:
[`docs/architecture.md`](./architecture.md) (project design & decisions),
[`docs/spec.md`](./spec.md) (guardrail parameters, contract interfaces, Claude prompt +
risk-signal schema), and [`docs/ui.md`](./ui.md) (UI/UX plan). This file defines the
rules you must follow while executing them.**

If a request conflicts with these rules, **stop and ask** rather than silently
deviating.

---

## 1. What we are building (one paragraph)

**Custos** — an **AI risk-guardian real-yield account** on **Mantle**. Users
deposit **USDC**; an AI agent (powered by the **Anthropic API**) earns tokenized-Treasury
(**USDY**) yield with an **Aave v3** USDC floor for liquidity, and **autonomously
de-risks on-chain** into **AUSD**/USDC when RWA risk appears (depeg, oracle
staleness, issuer/regulatory shock) — **only within hard on-chain guardrails** —
recording every decision **and its triggering evidence** on-chain under an
**ERC-8004** identity. The swap-to-USDY is only the resting state; the **verifiable
autonomous defense** is the product. See [`docs/architecture.md`](./architecture.md).

---

## 2. Non-negotiable rules

1. **Data vs. execution boundary.** The **1delta API** may be used for **reading
   data** and **swap routing/quoting only** (it aggregates Odos/Eisen/Nordstern/…).
   Its returned values are **never trusted for custody**. The vault must **never
   execute arbitrary third-party calldata.** Execution happens only through our own
   audited adapters (`UsdyAdapter`, `AaveV3Adapter`, `AusdAdapter`).
   **Aggregator exception (USDY/AUSD):** because USDY/AUSD liquidity on Mantle is
   fragmented across thin pools (Agni USDY/USDT, iZiSwap & Butter USDY/USDC —
   together ~$1.5k), no single-pool route is usable. `UsdyAdapter`/`AusdAdapter` may
   run swap calldata against **one pinned, allow-listed router** — the **1delta swap
   executor** (`0x5C019a…F05F4E` on Mantle, immutable at deploy), through which
   1delta's `/actions/swap` routes every trade now that Odos v2 is retired. This is
   *not* "arbitrary calldata", because the adapter (a) only ever targets that single
   pinned address and pre-approves only it, (b) enforces a **balance-delta `minOut`**
   it derives itself from the Ondo oracle NAV (the executor's reported output is never
   trusted), and (c) requires output to land on the adapter, so calldata paying anyone
   else nets a 0 delta and reverts (fail-closed). The agent MUST request quotes with
   `account = <adapter address>` so the executor pulls from / pays the adapter (and the
   adapter's standing approval covers the quote's `permissions` step). Aave adapters
   still call the pool directly with on-chain `minOut`. The pinned router address is
   verified on-chain; changing it requires a redeploy.
   **Swap-quote surface (allocator UI):** the agent API exposes `POST /swap/quote`
   (`agent/src/data/swapQuote.ts`) so the web allocator panel can build `swapData` for a
   manual USDY/AUSD rebalance **without holding the 1delta key** — the agent fetches the
   route with its own key server-side. It is a thin wrapper, not a new boundary: it only
   sizes a USDC↔USDY/AUSD leg for a known adapter, re-asserts the **pinned router** before
   returning, and returns calldata that is still inert until an ALLOCATOR runs it through
   the vault (where the adapter's balance-delta `minOut` and pinned-router checks bind on
   chain). It is rate-limited like `/ask` and never moves funds.
   **mUSD converter leg (USDY↔mUSD):** the RWA core (bucket 2) may be held as USDY or
   its rebasing $1 form mUSD. `UsdyAdapter` converts between them via the **Ondo mUSD
   contract's `wrap`/`unwrap`** — which IS the "Ondo Token Converter" (verified
   on-chain: mUSD `0xab57…7cF3`, `usdy()`==USDY, `oracle()`==RWADynamicOracle). This
   stays inside the boundary for the same reasons: the mUSD contract is pinned
   immutable, only `wrap`/`unwrap` are ever called (never arbitrary calldata), and an
   oracle-derived **balance-delta `minOut`** is enforced on the realized output. The
   conversion is oracle-priced and value-neutral (no DEX liquidity), so it changes only
   the *form* of the bucket, not its value or weight.
   **Addendum layers stay outside custody:** x402 micropayments (the agent pays a
   guardrail-bounded payer key for data, and sells its risk score) and the ERC-8183
   `CustosJobEscrow`/`CustosDeRiskEvaluator` (each de-risk modelled as a verifiable
   escrowed Job whose Evaluator IS the deterministic guardrail check) are
   record/payment/reputation layers — they escrow per-job bounties and feed ERC-8004
   reputation, and **never move vault deposits**. The on-chain `Guardrails` remain the
   sole authority over vault funds.
2. **Guardrails are the final authority.** On-chain guardrails (see [`docs/spec.md`
   §1](./spec.md): max weight/bucket, min idle+Aave liquidity buffer, max slippage,
   token/venue whitelist, rebalance-frequency cap, per-tx caps, pause/kill switch,
   add-strategy timelock, depeg/oracle-deviation guard) are **timelocked limits** (one-shot bootstrap at deploy; afterwards every change — tighten or loosen — queues behind the on-chain timelock, with a 1-hour hard floor on the delay and an explicit `cancelConfig`). The AI
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
5. **Custody safety.** USDC is the only deposit asset. USDY and AUSD are sourced via
   **DEX, blocklist-aware** (USDY uses a blocklist transfer hook), never via
   KYC-gated mint in the vault path. **No leverage/looping** (no RWA market on
   Mantle supports it). The ALLOCATOR is a guardrail-bounded hot key with a working
   **kill switch**.
6. **Verify before integrating.** Treat every external address as **unverified** until
   confirmed on-chain. Develop and test against `anvil --fork` of Mantle mainnet before
   deploying.
7. **Ground-truth reads.** For assets the vault actually holds (Aave position,
   USDY NAV via `RWADynamicOracle`, USDY DEX price, AUSD proof-of-reserves), read
   **directly via RPC** as the accounting source of truth; 1delta is breadth/UX only.
8. **Secrets.** Never commit secrets (RPC keys, Anthropic API keys, 1delta API key,
   deployer/ALLOCATOR private keys, WalletConnect projectId if private). Use `.env`
   (git-ignored) + documented `.env.example`. Never log secrets.
9. **Scope discipline.** Finish all **Must** items before any **Should**; **Should**
   before **Could**. Keep changes focused; don't introduce speculative features or
   premature abstractions.
10. **Definition of done.** A feature is not done until its test passes, it doesn't
    violate any rule in §2, and the relevant docs in [`docs/`](.) are updated to
    reflect the change.

---

## 3. Tech stack (do not substitute without asking)

- **Contracts:** Solidity + **Foundry** (forge, anvil, cast). Tests in Forge.
- **Frontend:** **React + Vite + Tailwind + daisyUI**; wallet via **RainbowKit +
  wagmi + viem**; reads via wagmi hooks, writes via viem. Clean/professional,
  purple accent, light+dark themes — see [`docs/ui.md`](./ui.md).
- **Backend/agent/API:** **Node.js + TypeScript + Fastify** + **viem** (no ethers).
- **TS tests:** **Vitest**.
- **Deploy:** **Docker** (backend + frontend) behind **Caddy** (or nginx) routing.
- **LLM:** **Anthropic API** (`@anthropic-ai/sdk`). Default model: `claude-haiku-4-5-20251001` (configurable via `ANTHROPIC_MODEL`). The thin mockable `LLMClient` interface in `agent/src/llm/` hides the provider. **Data:** **1delta API** + **Mantle RPC**.

---

## 4. Repository conventions

- **Languages:** TypeScript (strict mode on) for all JS-land code; Solidity for
  contracts. No JavaScript source files.
- **Solidity:** explicit visibility, custom errors over revert strings, NatSpec on
  external/public functions, checks-effects-interactions, reentrancy guards on
  fund-moving functions. Prefer well-audited libraries (OpenZeppelin/Solmate).
  Match the interface sketches in [`docs/spec.md`](./spec.md) §2 (refine as needed;
  keep names stable).
- **Naming:** contracts `PascalCase`; TS files `kebab-case`; React components
  `PascalCase`. Be descriptive.
- **Comments:** explain non-obvious intent/trade-offs/constraints only. Do **not**
  narrate what the code does. Never leave "explaining the change" comments.
- **Tests:** every contract that moves funds needs Forge tests on a Mantle fork
  (happy path + guardrail-violation + depeg/de-risk + liquidity-crunch withdrawal).
  Agent logic needs Vitest coverage for the risk engine + guardrail validator.
- **UI:** follow [`docs/ui.md`](./ui.md) (tokens, two daisyUI themes, components,
  a11y). Build screens with typed mock data first, then wire to chain/agent.
- **Money math:** never trust floats for on-chain amounts; use bigint/fixed-point;
  always enforce `minOut`/slippage on swaps.

---

## 5. Git & workflow

- **Branches:** Always use `claude/features` if it is available (reset to `origin/main`
  to pick up merged work if needed). If `claude/features` has unmerged commits that
  haven't landed in `main`, create a new branch (e.g. `claude/features-<slug>`) rather
  than overwriting in-progress work. Never develop directly on `main`.
- **Commits:** one logical change per commit, clear messages. Do not force-push or
  amend unless explicitly asked.
- **Push:** `git push -u origin <branch>`; retry network failures with backoff.
- **PRs:** **Create a GitHub PR after every completed task or logical step.** PR body
  must state: what was built, which tests pass, and any doc updates. Keep
  [`docs/architecture.md`](./architecture.md), [`docs/spec.md`](./spec.md),
  [`docs/ui.md`](./ui.md), [`docs/agents.md`](./agents.md), `CLAUDE.md`, and the Cursor
  rule in sync when the plan changes.
- **Cursor review comments:** When tagging Cursor for re-review on a PR comment,
  always use `@cursor` (e.g. `@cursor All items from your review are addressed.`).
  This ensures the automation picks up the request.

---

## 6. When in doubt

- Re-read [`docs/architecture.md`](./architecture.md) (strategy & design),
  [`docs/spec.md`](./spec.md) (params & interfaces), [`docs/ui.md`](./ui.md)
  (UI/UX), and this file (rules).
- If a decision isn't covered, pick the option that best protects **custody safety**,
  note it, and flag it.
- Anything touching guardrails, custody, the 1delta boundary, or scope → **ask first.**
