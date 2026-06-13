# CLAUDE.md

**Read these before doing anything:** `docs/agents.md` (canonical operating guide),
`docs/architecture.md` (project design & decisions), `docs/spec.md` (guardrail parameters,
contract interfaces, Claude prompt + risk-signal schema), and `docs/ui.md` (UI/UX plan).
This file restates only the non-negotiables so they are never missed.

## Project (one line)
**Custos** — an **AI risk-guardian real-yield account** on **Mantle** (chain ID
5000). Users deposit **USDC**; an AI agent (Anthropic API (Claude)) earns tokenized-Treasury
(**USDY**) yield with an **Aave v3** USDC liquidity floor, and **autonomously
de-risks on-chain** to **USDC** (with **AUSD** as a guardian-managed escape hatch) on RWA danger (depeg, oracle staleness,
issuer/regulatory shock), recording every decision **and its evidence** on-chain
under an **ERC-8004** identity. Track: **AI × RWA (Application path)**. The
verifiable autonomous defense — not the swap-to-USDY — is the product.

## Top non-negotiables (full list in `docs/agents.md` §2)
1. **1delta = data + swap routing/quoting; its output is never trusted for custody.**
   The off-chain 1delta API supplies market data and best-route swap calldata only.
   The vault never executes arbitrary third-party calldata. Execution = our own
   adapters (`UsdyAdapter`, `AaveV3Adapter`, `AusdAdapter`); Aave calls the pool
   directly. **USDY/AUSD swap exception:** Mantle USDY/AUSD liquidity is split across
   thin pools (~$1.5k total) with no usable single-pool route, so `UsdyAdapter`/
   `AusdAdapter` run the aggregator calldata against ONE pinned, allow-listed router —
   the **1delta swap executor** (`0x5C019a…F05F4E` on Mantle), through which 1delta's
   `/actions/swap` routes every trade (Odos v2 is retired). Safe because the router is
   immutable, the adapter pre-approves only that one contract and enforces an
   oracle-derived **balance-delta `minOut`** (executor output never trusted), and
   output must land on the adapter (else 0 delta → revert). The agent MUST request
   quotes with `account = <adapter address>` so the executor pulls from / pays the
   adapter. **mUSD converter leg:** the RWA core can also be held as Ondo **mUSD**;
   `UsdyAdapter` converts USDY↔mUSD by calling only `wrap`/`unwrap` on the pinned mUSD
   contract (the "Ondo Token Converter" — it has no separate contract), oracle-priced
   and value-neutral, with the same balance-delta `minOut`. See `docs/agents.md` §2.1.
2. **Guardrails are final.** LLM proposes → deterministic validator checks →
   timelocked on-chain guardrails (incl. depeg/oracle guard) backstop. The model is
   never the last line of defense. The LLM may only **tighten** risk, never loosen
   it (see `docs/spec.md` §3). On-chain `Guardrails` and the TS validator share constants
   from `packages/shared`.
3. **AI only where it beats an algorithm.** Keep yield/optimization/peg/oracle/
   liquidity/execution deterministic. No AI-washing.
4. **Mantle-only.** No other execution chains.
5. **Custody safety.** USDC deposit asset; USDY & AUSD via DEX (blocklist-aware),
   not KYC mint; **no leverage/looping**; ALLOCATOR is a guardrail-bounded hot key
   with a kill switch.
6. **Verify addresses on-chain; develop on `anvil --fork` of Mantle mainnet.**
7. **Never commit secrets** (RPC/Anthropic API/1delta keys, private keys). Use git-ignored
   `.env` + `.env.example`.
8. **Scope discipline:** Must → Should → Could. Keep changes focused; don't introduce
   speculative features or premature abstractions.

## Stack (do not substitute)
Solidity + Foundry · React + Vite + Tailwind + daisyUI · **RainbowKit + wagmi + viem
(frontend)** · Node/TS + Fastify + **viem (backend/agent — no ethers)** · Vitest +
Forge · Docker + Caddy · Anthropic API (Claude, `@anthropic-ai/sdk`) · 1delta API + Mantle RPC. UI: clean/professional,
purple accent, light+dark themes — see `docs/ui.md`.

## Workflow
Branch `claude/features`; one logical change per commit. **Create a GitHub PR
after every completed task or logical step.** Keep `docs/architecture.md` /
`docs/spec.md` / `docs/ui.md` / `docs/agents.md` / `CLAUDE.md` / the Cursor rule
in sync when the plan changes. When unsure about guardrails, custody, the 1delta
boundary, or scope — **ask first.**
