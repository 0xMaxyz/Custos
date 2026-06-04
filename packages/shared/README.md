# packages/shared

Shared types, constants, and deployed addresses — imported by `agent`, `web`, and `contracts` (via `Addresses.sol`).

## Contents

```
src/
  deployments.ts    Deployed contract addresses by chain id (5000 mainnet, 5003 testnet)
  addresses.ts      Verified Mantle protocol addresses (USDC, USDY, mUSD, AUSD, oracles, routers…)
  tokens.ts         Token metadata (decimals, symbols, chain-specific addresses)
  guardrails.ts     Guardrail constants — single source of truth for Guardrails.sol + TS validator
  types.ts          Shared TypeScript types (Allocation, RiskSignal, Decision, MarketSnapshot…)
```

## Why a shared package?

**The on-chain `Guardrails` values and the off-chain TS validator must stay in agreement.**
`guardrails.ts` is the single source of truth: `contracts/src/Guardrails.sol` imports
`Addresses.sol` which references these constants; the TS validator (`agent/src/guardrail-validator/`)
imports this package directly. Changing a guardrail value in one place without updating
the other is a bug.

## In-depth docs

- [docs/spec.md](../../docs/spec.md) — guardrail parameters these constants implement
- [docs/architecture.md](../../docs/architecture.md) — how the shared constants fit the system
