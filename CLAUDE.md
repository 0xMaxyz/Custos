# CLAUDE.md

**`AGENTS.md` is the canonical operating guide. `PLAN.md` is the full project plan.
`ROADMAP.md` is the PR-sized execution breakdown (per-phase tasks with What / Goal /
How-to-test). Read all three before doing anything.** This file restates only the
non-negotiables so they are never missed.

## Project (one line)
**Sentinel** — an **AI risk-guardian real-yield account** on **Mantle** (chain ID
5000). Users deposit **USDC**; an AI agent (Z.AI) earns tokenized-Treasury
(**USDY**) yield with an **Aave v3** USDC liquidity floor, and **autonomously
de-risks on-chain** into **AUSD**/USDC on RWA danger (depeg, oracle staleness,
issuer/regulatory shock), recording every decision **and its evidence** on-chain
under an **ERC-8004** identity. Track: **AI × RWA (Application path)**. The
verifiable autonomous defense — not the swap-to-USDY — is the product.

## Top non-negotiables (full list in `AGENTS.md` §2)
1. **1delta = data + optional swap routing ONLY.** Never in the custody/execution
   path. The vault never executes arbitrary third-party calldata. Execution =
   our own adapters (`UsdyAdapter`, `AaveV3Adapter`, `AusdAdapter`) calling
   protocols/DEXs directly with on-chain `minOut`/guardrails.
2. **Guardrails are final.** LLM proposes → deterministic validator checks →
   immutable on-chain guardrails (incl. depeg/oracle guard) backstop. The model is
   never the last line of defense.
3. **AI only where it beats an algorithm.** Keep yield/optimization/peg/oracle/
   liquidity/execution deterministic. No AI-washing.
4. **Mantle-only.** No other execution chains.
5. **Custody safety.** USDC deposit asset; USDY & AUSD via DEX (blocklist-aware),
   not KYC mint; **no leverage/looping**; ALLOCATOR is a guardrail-bounded hot key
   with a kill switch.
6. **Verify addresses on-chain; develop on `anvil --fork` of Mantle mainnet.**
   Phase-0 liquidity/oracle gates are mandatory.
7. **Never commit secrets** (RPC/Z.AI/1delta keys, private keys). Use git-ignored
   `.env` + `.env.example`.
8. **Scope discipline:** Must → Should → Could. Feature-freeze **2026-06-12**.
   Work in PR-sized tasks per `ROADMAP.md`; don't start a phase before the prior
   phase's exit criteria are met.

## Stack (do not substitute)
Solidity + Foundry · React/Vite/Tailwind/daisyUI · Node/TS + Fastify · Vitest +
Forge · Docker + Caddy · Z.AI · 1delta API + Mantle RPC.

## Workflow
Branches `cursor/<name>-46a8` (lowercase); one logical change per commit; draft PRs
via the PR tool; keep `PLAN.md` / `ROADMAP.md` / `AGENTS.md` / `CLAUDE.md` / the
Cursor rule in sync. When unsure about guardrails, custody, the 1delta boundary, or
scope — **ask first.**
