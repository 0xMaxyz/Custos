# CLAUDE.md

**`AGENTS.md` is the canonical operating guide. `PLAN.md` is the full project plan.
Read both before doing anything.** This file restates only the non-negotiables so
they are never missed.

## Project (one line)
**Sentinel** — an autonomous, risk-managed RWA yield vault on **Mantle** (chain ID
5000). An AI agent (Z.AI) allocates **USDC** across **USDY** (tokenized US
Treasuries), **Aave v3**, and **INIT**, rebalancing only within hard on-chain
guardrails and logging every decision on-chain under an **ERC-8004** identity.
Track: **AI × RWA**.

## Top non-negotiables (full list in `AGENTS.md` §2)
1. **1delta = data + optional swap routing ONLY.** Never in the custody/execution
   path. The vault never executes arbitrary third-party calldata. Execution =
   our own adapters calling protocols directly with on-chain `minOut`/guardrails.
2. **Guardrails are final.** LLM proposes → deterministic validator checks →
   immutable on-chain guardrails backstop. The model is never the last line of defense.
3. **AI only where it beats an algorithm.** Keep yield/optimization/peg/utilization/
   execution deterministic. No AI-washing.
4. **Mantle-only.** No other execution chains.
5. **Custody safety.** USDC deposit asset; USDY via DEX (blocklist-aware), not
   KYC mint; ALLOCATOR is a guardrail-bounded hot key with a kill switch.
6. **Verify addresses on-chain; develop on `anvil --fork` of Mantle mainnet.**
7. **Never commit secrets** (RPC/Z.AI/1delta keys, private keys). Use git-ignored
   `.env` + `.env.example`.
8. **Scope discipline:** Must → Should → Could. Feature-freeze **2026-06-12**.

## Stack (do not substitute)
Solidity + Foundry · React/Vite/Tailwind/daisyUI · Node/TS + Fastify · Vitest +
Forge · Docker + Caddy · Z.AI · 1delta API + Mantle RPC.

## Workflow
Branches `cursor/<name>-46a8` (lowercase); one logical change per commit; draft PRs
via the PR tool; keep `PLAN.md` / `AGENTS.md` / `CLAUDE.md` / the Cursor rule in
sync. When unsure about guardrails, custody, the 1delta boundary, or scope — **ask
first.**
