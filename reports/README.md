# reports/

Generated liquidity/peg snapshots — **do not edit by hand**.

`mantle-liquidity.{json,md}` are written by `scripts/check-mantle-liquidity.mjs`
(`--write`) and committed weekly by `.github/workflows/liquidity-monitor.yml`.

These reflect DeFiLlama breadth + on-chain tokenized supply for **monitoring
only**. The authoritative executable-depth gate is the Foundry fork test
`testLiquidityGateUsdy` in `contracts/test/Fork.t.sol`.
