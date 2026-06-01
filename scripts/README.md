# scripts/

Standalone operational scripts. No build step — run directly with Node 22+.

## check-mantle-liquidity.mjs

Live liquidity + peg probe for Sentinel's RWA legs (USDY, mUSD, AUSD, USDC) on
Mantle. Answers "is there real DEX liquidity for USDY/mUSD on Mantle right now,
and are the stables at peg?" — the question that decides whether the de-risk
swaps Sentinel relies on are actually executable.

```sh
node scripts/check-mantle-liquidity.mjs              # human-readable report
node scripts/check-mantle-liquidity.mjs --json       # machine-readable JSON
node scripts/check-mantle-liquidity.mjs --write      # write reports/mantle-liquidity.{json,md}
node scripts/check-mantle-liquidity.mjs --min=250000 # exit 1 if RWA DEX liquidity < $250k (CI alert)
```

Token addresses (USDC/USDY/AUSD/WMNT/mUSD) are read from
`packages/shared/src/tokens.ts` — the single source of truth.

Optional env:

- `MANTLE_RPC_URL` — defaults to `https://rpc.mantle.xyz`.
- `MIN_LIQUIDITY_USD` (CI) — when set, the monitor workflow fails on thin liquidity.

**Scope:** DeFiLlama pool TVL measures _breadth_, not executable USDC↔USDY swap
depth at vault sizes. The authoritative liquidity gate is the Foundry fork test
`testLiquidityGateUsdy` (`contracts/test/Fork.t.sol`); treat this script as
monitoring / early-warning only.

Sources (all read-only, no API keys): DeFiLlama yields (pool TVL), DeFiLlama
coins (peg), Mantle RPC (`totalSupply()` for tokenized supply).

`.github/workflows/liquidity-monitor.yml` runs this weekly (and on demand) from
a networked runner and commits the snapshot to `reports/`.
