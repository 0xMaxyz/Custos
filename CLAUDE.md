# CLAUDE.md

**Read these before doing anything:** `AGENTS.md` (canonical operating guide),
`PLAN.md` (full plan), `ROADMAP.md` (PR-sized per-phase tasks with What/Goal/Test),
`SPEC.md` (guardrail parameters, contract interfaces, Anthropic API (Claude) prompt + risk-signal
schema), and `UI.md` (UI/UX plan). This file restates only the non-negotiables so
they are never missed.

## Project (one line)
**Custos** — an **AI risk-guardian real-yield account** on **Mantle** (chain ID
5000). Users deposit **USDC**; an AI agent (Anthropic API (Claude)) earns tokenized-Treasury
(**USDY**) yield with an **Aave v3** USDC liquidity floor, and **autonomously
de-risks on-chain** into **AUSD**/USDC on RWA danger (depeg, oracle staleness,
issuer/regulatory shock), recording every decision **and its evidence** on-chain
under an **ERC-8004** identity. Track: **AI × RWA (Application path)**. The
verifiable autonomous defense — not the swap-to-USDY — is the product.

## Top non-negotiables (full list in `AGENTS.md` §2)
1. **1delta = data + swap routing/quoting ONLY.** Never in the custody/execution
   path. The vault never executes arbitrary third-party calldata. Execution =
   our own adapters (`UsdyAdapter`, `AaveV3Adapter`, `AusdAdapter`). Aave/AUSD call
   protocols/DEXs directly. **USDY exception:** `UsdyAdapter` runs swap calldata
   against ONE pinned, allow-listed aggregator router (Odos on Mantle) — safe
   because the router is immutable, the adapter enforces an oracle-derived
   **balance-delta `minOut`** (router output never trusted), and output must land
   on the adapter (else 0 delta → revert). Needed because Mantle USDY liquidity is
   split across thin pools (~$1.5k total) with no usable single-pool route. **mUSD
   converter leg:** the RWA core can also be held as Ondo **mUSD**; `UsdyAdapter`
   converts USDY↔mUSD by calling only `wrap`/`unwrap` on the pinned mUSD contract
   (the "Ondo Token Converter" — it has no separate contract), oracle-priced and
   value-neutral, with the same balance-delta `minOut`. See `AGENTS.md` §2.1.
2. **Guardrails are final.** LLM proposes → deterministic validator checks →
   immutable on-chain guardrails (incl. depeg/oracle guard) backstop. The model is
   never the last line of defense. The LLM may only **tighten** risk, never loosen
   it (see `SPEC.md` §3). On-chain `Guardrails` and the TS validator share constants
   from `packages/shared`.
3. **AI only where it beats an algorithm.** Keep yield/optimization/peg/oracle/
   liquidity/execution deterministic. No AI-washing.
4. **Mantle-only.** No other execution chains.
5. **Custody safety.** USDC deposit asset; USDY & AUSD via DEX (blocklist-aware),
   not KYC mint; **no leverage/looping**; ALLOCATOR is a guardrail-bounded hot key
   with a kill switch.
6. **Verify addresses on-chain; develop on `anvil --fork` of Mantle mainnet.**
   Phase-0 liquidity/oracle gates are mandatory.
7. **Never commit secrets** (RPC/Anthropic API (Claude)/1delta keys, private keys). Use git-ignored
   `.env` + `.env.example`.
8. **Scope discipline:** Must → Should → Could. Feature-freeze **2026-06-12**.
   Work in PR-sized tasks per `ROADMAP.md`; don't start a phase before the prior
   phase's exit criteria are met.

## Stack (do not substitute)
Solidity + Foundry · React + Vite + Tailwind + daisyUI · **RainbowKit + wagmi + viem
(frontend)** · Node/TS + Fastify + **viem (backend/agent — no ethers)** · Vitest +
Forge · Docker + Caddy · Anthropic API (Claude, `@anthropic-ai/sdk`) · 1delta API + Mantle RPC. UI: clean/professional,
purple accent, light+dark themes — see `UI.md`.

## Workflow
Branch `claude/features`; one logical change per commit. **Create a GitHub PR
after every completed task or logical step** — include phase, task number(s),
what was built, and which gate passes. Mark tasks `[x] DONE` in `ROADMAP.md`
and record the PR number so future sessions know current state. Keep
`PLAN.md` / `ROADMAP.md` / `SPEC.md` / `UI.md` / `AGENTS.md` / `CLAUDE.md` /
the Cursor rule in sync. When unsure about guardrails, custody, the 1delta
boundary, or scope — **ask first.**
