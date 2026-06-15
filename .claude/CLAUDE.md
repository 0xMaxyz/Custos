# CLAUDE.md

**Read these before doing anything:** `docs/agents.md` (canonical operating guide),
`docs/architecture.md` (project design & decisions), `docs/spec.md` (guardrail parameters,
contract interfaces, Claude prompt + risk-signal schema), and `docs/ui.md` (UI/UX plan).
This file restates only the non-negotiables so they are never missed.

## Top non-negotiables (full list in `docs/agents.md` §2)

1. **Guardrails are final.** LLM proposes → deterministic validator checks →
   timelocked on-chain guardrails (incl. depeg/oracle guard) backstop. The model is
   never the last line of defense. The LLM may only **tighten** risk, never loosen
   it (see `docs/spec.md` §3). On-chain `Guardrails` and the TS validator share constants
   from `packages/shared`.
2. **AI only where it beats an algorithm.** Keep yield/optimization/peg/oracle/
   liquidity/execution deterministic. No AI-washing.
3. **Mantle-only.** No other execution chains.
4. **Custody safety.** USDC deposit asset; USDY & AUSD via DEX (blocklist-aware),
   not KYC mint; **no leverage/looping**; ALLOCATOR is a guardrail-bounded hot key
   with a kill switch.
5. **Verify addresses on-chain; develop on `anvil --fork` of Mantle mainnet.**
6. **Never commit secrets** (RPC/Anthropic API/1delta keys, private keys). Use git-ignored
   `.env` + `.env.example`.
7. **Scope discipline:** Must → Should → Could. Keep changes focused; don't introduce
   speculative features or premature abstractions.
