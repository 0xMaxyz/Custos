# Sentinel — Execution Roadmap (micro-plans)

Operational breakdown of the phases in `PLAN.md` into **small, PR-sized tasks**.
Each task states **What** (work), **Goal** (done criteria), and **Test** (how to
verify). Read `PLAN.md` (strategy) and `AGENTS.md` (rules) first.

## How to use this

- **One task = one focused change.** Related tasks are grouped into a suggested PR
  (the `· PR-xx` tag). Batch a PR's tasks together; don't mix PRs.
- A task is **done** only when its Test passes (and lint/build are green).
- **Do not start a phase until the prior phase's exit criteria are met.** Phase 0 is
  a hard go/no-go gate.
- Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.
- Develop on `claude/features`. Keep `PLAN.md`/`ROADMAP.md` in sync if
  scope shifts.

## PR map (suggested)

**Core PRs** (must ship):

| PR    | Tasks   | Theme                                                                        |
| ----- | ------- | ---------------------------------------------------------------------------- | ---------- |
| PR-0a | 0.1     | Monorepo scaffold                                                            |
| PR-0b | 0.2–0.6 | Fork harness + verification GATE + **demo-trigger harness**                  |
| PR-1a | 1.1–1.4 | Roles, guardrails, vault skeleton, adapter interface                         |
| PR-1b | 1.5–1.6 | Aave adapter + rebalance/withdraw                                            |
| PR-2a | 2.1–2.3 | DEX lib + USDY valuation + UsdyAdapter                                       |
| PR-2b | 2.4–2.6 | Depeg/oracle guard + de-risk + decision ledger + **passive-USDY baseline**   | `[x] DONE` |
| PR-2d | 2.7     | RWA core **mUSD leg** (USDY↔mUSD via Ondo wrap/unwrap converter)             | `[x] DONE` · [PR #20](https://github.com/0xMaxyz/miu/pull/20) |
| PR-3a | 3.1–3.3 | Agent config + ingestion + deterministic risk engine                         | `[x] DONE` · [PR #7](https://github.com/0xMaxyz/miu/pull/7) |
| PR-3b | 3.4–3.6 | **Anthropic LLM client** + news/attestation hero path + guardrail validator  | `[x] DONE` · [PR #9](https://github.com/0xMaxyz/miu/pull/9) |
| PR-3c | 3.7–3.8 | Executor/signer + scheduler + e2e on fork                                    | `[x] DONE` · [PR #10](https://github.com/0xMaxyz/miu/pull/10) |
| PR-4a | 4.1–4.2 | ERC-8004 identity + agent card                                               | `[x] DONE` |
| PR-4b | 4.3–4.4 | Web scaffold + dashboard reads                                               | `[x] DONE` · [PR #11](https://github.com/0xMaxyz/miu/pull/11) |
| PR-4c | 4.5–4.8 | Deposit/withdraw + risk-guardian feed + **baseline counter** + identity card | `[x] DONE` (fixtures; live reads → PR-5a) · [PR #13](https://github.com/0xMaxyz/miu/pull/13) |
| PR-5a | 5.1–5.3 | Deploy scripts + mainnet deploy + verify + real-funds smoke test             | 5.1 `[x] DONE` · 5.2–5.3 `[ ]` pending mainnet keys · [PR #14](https://github.com/0xMaxyz/miu/pull/14) |
| PR-6a | 6.1–6.5 | Public deploy, docs, video, submission                                       |
| PR-7  | 7.1–7.4 | Buffer / contingency                                                         |

**Addendum PRs** (only after Phase 5a exits):

| PR    | Tasks     | Theme                         | Status                                                                          |
| ----- | --------- | ----------------------------- | ------------------------------------------------------------------------------- |
| PR-A1 | A1.1–A1.2 | AusdAdapter + AUSD PoR signal | A1.1 `[x] DONE` · [PR #15](https://github.com/0xMaxyz/miu/pull/15) · A1.2 `[x] DONE` |
| PR-A2 | A2.1      | Risk radar viz                | `[x] DONE` · [PR #17](https://github.com/0xMaxyz/miu/pull/17)                    |
| PR-A3 | A3.1–A3.2 | Conversational agent + alerts | A3.1 `[x] DONE` · [PR #16](https://github.com/0xMaxyz/miu/pull/16) · A3.2 `[x] DONE` · [PR #17](https://github.com/0xMaxyz/miu/pull/17) |
| PR-A4 | A4.1–A4.2 | Agent x402 micropayments + ERC-8183 jobs | `[x] DONE` · [PR #21](https://github.com/0xMaxyz/miu/pull/21) |

---

## Phase 0 — Foundations & Gates

**Phase goal:** repo scaffolding + a Mantle mainnet-fork harness, and **prove every
external dependency exists and is usable.** This is a go/no-go gate; if the
liquidity gate fails, switch to the AUSD-primary fallback before Phase 1.

### 0.1 — Monorepo scaffold · _PR-0a_ · `[x] DONE` · [PR #2](https://github.com/0xMaxyz/miu/pull/2)

- **What:** workspace layout `/contracts` (Foundry), `/agent` (Node/TS + Fastify),
  `/web` (React/Vite/Tailwind/daisyUI), `/packages/shared` (types + addresses);
  root tooling (workspaces, eslint, prettier, base tsconfig), `.gitignore`
  (`.env`, `out`, `broadcast`, `cache`, `node_modules`), `.env.example`,
  `docker-compose.yml` + `Caddyfile` skeletons.
- **Goal:** a clean clone builds/typechecks across all packages.
- **Test:** `forge build`, `pnpm -r typecheck`, `pnpm -r lint`, and
  `docker compose config` all succeed; CI script documented.

### 0.2 — Mantle fork test harness · _PR-0b_ · `[x] DONE`

- **What:** Foundry fork profile using `MANTLE_RPC_URL` at a pinned block; base test
  utilities (token labels, `deal`-via-swap helper).
- **Goal:** tests run against a deterministic Mantle mainnet fork.
- **Test:** `forge test --fork-url $MANTLE_RPC_URL --match-test testForkSanity`
  asserts `block.chainid == 5000` and reads `USDC.decimals() == 6`.

### 0.3 — On-chain address & capability verification (GATE) · _PR-0b_ · `[x] DONE` (block-N stamps pending CI fork gate)

- **Status:** addresses resolved + committed (`packages/shared/addresses.ts` + `Addresses.sol`);
  `Fork.t.sol`/`ForkPhase2a`/`ForkPhase2d`/`ForkPhase4a` assert `extcodesize > 0` and a basic call
  per interface (oracle `getPrice()`, Aave reserve data, mUSD `usdy()/oracle()`, ERC-8004 registries).
  ERC-8004 decision made: **use the canonical 0x8004 singletons** (SPEC §2.5). Residual: the literal
  `// verified @ block N` stamps land once the post-merge `fork-tests` job pins a block.
- **What:** resolve + verify and record in `packages/shared/addresses.ts`
  (with "verified @ block N"): USDC; USDY + `RWADynamicOracle`; AUSD; Aave v3
  `Pool` + `PoolDataProvider` + aUSDC; DEX router(s) for USDY/USDC, USDY/WMNT,
  AUSD pairs; ERC-8004 Identity/Reputation registries (present on Mantle?).
- **Goal:** a committed, verified registry; explicit decision on ERC-8004
  (use 0x8004 singletons vs deploy our own).
- **Test:** fork test asserts `extcodesize > 0` for each address and a basic call
  per interface succeeds (`oracle` returns price; `Pool.getReserveData(USDC)`
  returns aToken; router quote returns > 0).

### 0.4 — Liquidity & swap-quote gate · _PR-0b_ · `[x] DONE` (GO decision recorded; live monitor supersedes one-shot table)

- **Status:** liquidity characterized (USDY ~$1.5k fragmented across Agni/iZiSwap/Butter) → **GO
  decision = route via a pinned Odos aggregator** (not single-pool) **+ a `maxUsdyNotionalUsdc` $5k
  absolute cap**, instead of the AUSD-primary fallback (AGENTS.md §2.1, PR-2d). Ongoing slippage/peg
  depth is automated by `scripts/check-mantle-liquidity.mjs` + the weekly `liquidity-monitor.yml`
  (sources `tokens.ts`), which supersedes a one-shot committed table.
- **What:** quote USDC→USDY, USDC→AUSD, and reverse at $100 / $1k / $10k on the
  chosen router on the fork; record slippage.
- **Goal:** documented slippage table + a GO decision (e.g. ≤0.5% at $1k) or trigger
  the **AUSD-primary fallback**.
- **Test:** fork test executes swaps, asserts `received >= minOut` for the target
  slippage, and logs the table.

### 0.5 — USDY transfer-hook (blocklist) check · _PR-0b_ · `[x] DONE`

- **Status:** `ForkPhase2a.t.sol::testForkUsdyAdapterNotBlocklisted` asserts neither the vault nor the
  adapter is on the USDY blocklist (`isBlocked(...) == false`); the live USDY→mUSD→USDY round-trip in
  `ForkPhase2d.t.sol` further exercises a real USDY `transferFrom` (blocklist hook) from the adapter.
- **What:** confirm a fresh contract can receive/hold/transfer USDY (not blocked);
  characterize `beforeTransfer` behavior.
- **Goal:** confirmation the vault can custody USDY.
- **Test:** fork test swaps USDC→USDY into a test contract, transfers out, asserts
  success and `Blocklist.isBlocked(testContract) == false`.

### 0.6 — Demo-trigger harness · _PR-0b_ · `[x] DONE` (offline mock; wire to vault oracle Phase 2+)

- **What:** a Forge/Vitest test-helper that injects a controllable depeg or
  oracle-staleness condition into the fork — e.g. mock the DEX router to return a
  low USDY spot, or `vm.warp` past the oracle range end. Used during the demo video
  to fire the de-risk on demand without waiting for a real-world event.
- **Goal:** reliably trigger the hero de-risk moment on a fork (and testnet if
  possible) at any time.
- **Test:** Forge helper: call `injectDepeg(bps)` → oracle-guard fires → `deRisk`
  succeeds; call `clearDepeg()` → normal operation resumes.

**Exit:** scaffold builds; fork tests read Aave/USDY/AUSD; liquidity GO (or fallback
chosen); ERC-8004 path decided; depeg can be injected cleanly.

---

## Phase 1 — Vault core (no RWA yet)

**Phase goal:** a working ERC-4626 USDC vault with the Aave leg, idle buffer,
guardrails, and deposit/withdraw.

### 1.1 — Roles & access control · _PR-1a_ · `[x] DONE`

- **What:** `ADMIN`, `ALLOCATOR`, `GUARDIAN` roles; `Pausable`; kill switch.
- **Goal:** only ALLOCATOR rebalances; GUARDIAN can pause; ADMIN manages config.
- **Test:** Forge unit tests: unauthorized calls revert; pause blocks
  deposit/rebalance; kill switch enables emergency withdraw-only.

### 1.2 — Guardrails module · _PR-1a_ · `[x] DONE`

- **What:** params: `maxWeightPerBucket`, `minLiquidityBufferBps`, `maxSlippageBps`,
  token/venue whitelist, `maxRebalanceFreq`, `perTxCap`, `addStrategyTimelock`;
  pure validation helpers.
- **Goal:** a module the vault consults to accept/reject a proposed allocation.
- **Test:** Forge unit tests: over-cap/over-slippage/non-whitelisted proposals
  revert; within-bounds pass; timelock enforced for new strategies.

### 1.3 — `YieldVault` ERC-4626 skeleton · _PR-1a_ · `[x] DONE`

- **What:** USDC asset; deposit/mint/withdraw/redeem; `totalAssets()` = idle +
  Σ adapter assets; idle-buffer accounting; reentrancy guards.
- **Goal:** deposit/withdraw works with idle-only; share math correct.
- **Test:** Forge: deposit→redeem round-trip; `totalAssets` tracks; fuzz that share
  price is non-decreasing absent losses.

### 1.4 — Strategy adapter interface · _PR-1a_ · `[x] DONE`

- **What:** `IStrategyAdapter` (`deposit`, `withdraw`, `totalAssets`,
  `maxWithdrawable`); vault registry of adapters + target weights.
- **Goal:** pluggable adapters behind a stable interface.
- **Test:** Forge: a mock adapter; vault allocates/deallocates to it; invariants hold.

### 1.5 — `AaveV3Adapter` · _PR-1b_ · `[x] DONE` · [PR #4](https://github.com/0xMaxyz/miu/pull/4)

- **What:** supply/withdraw USDC on Aave v3 Mantle; `totalAssets` = aUSDC balance;
  `maxWithdrawable` = available pool liquidity.
- **Goal:** vault can route idle USDC to Aave and pull it back.
- **Test:** fork test: deposit → allocate to Aave → `warp` → aUSDC grew →
  full withdraw returns ≥ principal.

### 1.6 — `rebalance()` + withdraw queue · _PR-1b_ · `[x] DONE` · [PR #4](https://github.com/0xMaxyz/miu/pull/4)

- **What:** `rebalance(targetWeights, decisionURI, rationaleHash)` (ALLOCATOR),
  enforces guardrails + buffer; withdrawals pull idle→Aave in queue order respecting
  available liquidity; emit `Decision`.
- **Goal:** allocator moves funds idle↔Aave within guardrails; events emitted.
- **Test:** fork test: rebalance hits target weights (±tolerance); large withdraw
  served from idle+Aave; guardrail-violating rebalance reverts.

**Exit:** deposit → allocate to Aave → withdraw works on fork; guardrails enforced.

---

## Phase 2 — RWA leg + risk guard

**Phase goal:** USDY bucket via DEX with oracle valuation, the depeg/oracle guard,
the de-risk path, and the on-chain decision/benchmark ledger.

### 2.1 — DEX swap library · _PR-2a_ · `[x] DONE` · [PR #5](https://github.com/0xMaxyz/miu/pull/5) · **REVISED PR-2d**

- **What:** minimal `exactIn` swap wrapper for the chosen Mantle router with
  `minOut` + `deadline`; configured paths USDC↔USDY, USDC↔AUSD.
- **Goal:** trustless swaps with on-chain slippage protection.
- **Test:** fork test: USDC→USDY→USDC respects `minOut`; slippage within guardrail.
- **⚠ REVISED (PR-2d):** Mantle USDY liquidity is fragmented across thin pools
  (Agni USDY/USDT ~$0.97k, iZiSwap & Butter USDY/USDC ~$0.63k — ~$1.5k total), so a
  single-pool Merchant Moe route is unusable. Replaced `SwapLib` (Merchant Moe LB)
  with **`AggregatorSwapLib`**: `UsdyAdapter` runs swap calldata against ONE pinned,
  allow-listed aggregator router (Odos on Mantle) and enforces an oracle-derived
  **balance-delta `minOut`** (router output never trusted; output must land on the
  adapter or the 0-delta reverts). Off-chain route comes from 1delta's routing quote
  (`OneDeltaClient.getSwapQuote`). Boundary impact documented in `AGENTS.md` §2.1 /
  `CLAUDE.md` #1. Swap-exec covered by offline mock tests (`Phase2a.t.sol`); live
  fork swap dropped (can't generate aggregator calldata deterministically on a fork).

### 2.2 — USDY valuation via `RWADynamicOracle` · _PR-2a_ · `[x] DONE` · [PR #5](https://github.com/0xMaxyz/miu/pull/5)

- **What:** read USDY NAV for valuation; staleness check (timestamp/round).
- **Goal:** vault values USDY by oracle NAV; detects stale oracle.
- **Test:** fork test: USDY holdings valued at oracle price; simulated stale oracle
  flips the staleness flag.

### 2.3 — `UsdyAdapter` · _PR-2a_ · `[x] DONE` · [PR #5](https://github.com/0xMaxyz/miu/pull/5) · **REVISED PR-2d**

- **What:** allocate = swap USDC→USDY (`minOut`); withdraw = swap USDY→USDC
  (`minOut`); `totalAssets` via oracle; `maxWithdrawable` via liquidity cap;
  blocklist-aware.
- **Goal:** USDY is a managed bucket the vault can enter/exit.
- **Test:** fork test: rebalance into USDY; `totalAssets` stable; withdraw unwinds
  USDY→USDC ≥ `minOut`.
- **⚠ REVISED (PR-2d):** executes via the pinned aggregator (see 2.1). Constructor
  drops the Merchant Moe bin-step/version params; `swapData` now carries aggregator
  calldata (empty reverts — no on-chain default route). Consequence: synchronous
  user redemptions are served only from **instant liquidity (IDLE + Aave)**, since
  USDY can only be unwound with off-chain calldata — `YieldVault._ensureLiquidity`
  no longer drains USDY/AUSD on the redeem path (matches the 15% `minInstantLiquidityBps`
  floor). Also added Guardrails `maxUsdyNotionalUsdc` ($5k) absolute USDY cap.

### 2.4 — Depeg / oracle-deviation guard · _PR-2b_ · `[x] DONE` · [PR #6](https://github.com/0xMaxyz/miu/pull/6)

- **What:** on-chain guard comparing USDY DEX spot vs oracle NAV (deviation bps) +
  staleness; on breach, block new USDY allocation and allow/force de-risk.
- **Goal:** deterministic on-chain trigger gating USDY exposure.
- **Test:** fork test with mocked router spot (or a depeg block): guard flips and
  new USDY allocation reverts; normal conditions pass.

### 2.5 — De-risk path · _PR-2b_ · `[x] DONE` · [PR #6](https://github.com/0xMaxyz/miu/pull/6)

- **What:** `deRisk()` (ALLOCATOR/GUARDIAN) rotates USDY→USDC/AUSD; emits `Decision`
  with `reason` + `evidenceHash`.
- **Goal:** one call exits USDY to safety, logged with evidence.
- **Test:** fork test: trip guard → `deRisk` → USDY balance 0, safe bucket up,
  `Decision` carries evidence fields.

### 2.6 — `AgentBenchmark` ledger + passive-USDY baseline · _PR-2b_ · `[x] DONE` · [PR #6](https://github.com/0xMaxyz/miu/pull/6)

- **What:** record each decision (pre/post weights, `rationaleHash`, `evidenceURI`,
  timestamp); `updateOutcome()` writes realized APY / drawdown-avoided; **baseline
  tracking**: each cycle snapshots what a 100%-USDY passive holder would hold
  (by oracle NAV), so the contract can emit the bps delta Sentinel outperformed
  or protected vs passive.
- **Goal:** verifiable on-chain decision + outcome ledger **with a meaningful
  benchmark** — the Turing Test answer on-chain.
- **Test:** Forge: events emitted with expected fields; passive-baseline delta
  computed correctly on de-risk; `updateOutcome` access-gated and stored.

### 2.7 — mUSD leg for `UsdyAdapter` (RWA core: USDY + mUSD) · _PR-2d_ · `[x] DONE` · [PR #20](https://github.com/0xMaxyz/miu/pull/20)

- **What:** extend the existing `UsdyAdapter` to also hold/route the **mUSD** form of
  the RWA core and convert USDY↔mUSD via the **Ondo Token Converter**, using whichever
  DEX leg is deeper. No new bucket — mUSD stays in bucket 2. (Needs the Ondo Token
  Converter address + interface from the Ondo docs; verify on-chain in the Phase 0.3
  gate — DO NOT guess.)
- **Goal:** the RWA core can be entered/exited as USDY *or* mUSD interchangeably.
- **Test:** fork test: enter via mUSD; USDY↔mUSD convert round-trips; `totalAssets`
  stable across the conversion; exit unwinds → USDC ≥ `minOut`.
- **VERIFIED on-chain (Mantle 5000, no guessing):** the "Ondo Token Converter" is the
  **mUSD token contract itself** (`0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3`, 18 dec),
  which hosts `wrap(uint256)` USDY→mUSD and `unwrap(uint256)` mUSD→USDY — there is no
  separate converter. `mUSD.usdy()` == USDY, `mUSD.oracle()` == the RWADynamicOracle.
  A live `deal`-funded USDY→mUSD→USDY round-trip on a Mantle fork is value-neutral
  (100 USDY → 113.49 mUSD at NAV 1.13494 → 100.0 USDY). Source: Ondo Mantle
  integration guidelines + addresses page.
- **Built:** `interfaces/IMusd.sol` (wrap/unwrap + usdy/oracle getters, documents the
  on-chain verification). `UsdyAdapter` gains an optional pinned `MUSD` immutable
  (`address(0)` = USDY-only): `totalAssets()` now values USDY at oracle NAV **+ mUSD at
  $1 face** (conserved across a conversion); `convertToMusd`/`convertToUsdy` (vault-only,
  oracle-derived balance-delta minOut, target only the pinned mUSD — never arbitrary
  calldata); `emergencyWithdrawAll`/`withdraw` are input-agnostic so the same exit path
  unwinds USDY **or** mUSD → USDC. `YieldVault.convertRwaLeg(bool,uint,uint)` is the
  ALLOCATOR passthrough — exposure-neutral (no weight change), so it intentionally
  skips `validateRebalance`. Deploy script wires mainnet `MAINNET_MUSD` / testnet
  `TESTNET_MUSD`. `packages/shared` `ondoTokenConverter` = mUSD address (+ invariant
  test). Tests: `Phase2d.t.sol` (18 offline) + `ForkPhase2d.t.sol` (3 fork);
  full suite 142 offline + Phase2 fork green.

**Exit:** a USDY→safe rotation emits a verifiable on-chain decision with evidence; passive-USDY baseline delta is recorded.

---

## Phase 3 — AI agent (off-chain)

**Phase goal:** the Fastify service: ingest data → deterministic risk engine →
LLM rationale (news/attestation hero path) → guardrail validator → signer → scheduler, driving the contracts on a fork.

### 3.1 — Config & types · _PR-3a_ · `[x] DONE` · [PR #7](https://github.com/0xMaxyz/miu/pull/7)

- **What:** shared types (`Allocation`, `RiskSignal`, `Decision`); env/config loader;
  viem clients (read + ALLOCATOR signer); pull addresses from `packages/shared`.
- **Goal:** typed, validated foundation.
- **Test:** Vitest: config loader rejects missing/invalid env; type/unit tests.

### 3.2 — Data ingestion (read) · _PR-3a_ · `[x] DONE` · [PR #7](https://github.com/0xMaxyz/miu/pull/7)

- **What:** 1delta client (Aave pools/IRM/yields, Mantle) + RPC readers (USDY NAV +
  DEX spot, Aave reserve data, AUSD PoR); caching layer.
- **Goal:** a `snapshot()` returning all market + risk inputs.
- **Test:** Vitest with mocked HTTP/RPC for shape + cache TTL; one integration test
  against a local fork.

### 3.3 — Deterministic risk engine · _PR-3a_ · `[x] DONE` · [PR #7](https://github.com/0xMaxyz/miu/pull/7)

- **What:** pure functions: yield spread (USDY-implied APY vs Aave supply APY), peg
  deviation bps, oracle staleness, buffer requirement, constrained target-weight
  proposer.
- **Goal:** snapshot → candidate allocation + risk flags, deterministically.
- **Test:** Vitest table-driven (normal / depeg / stale / low-liquidity) → expected
  weights & flags; pure, no network.

### 3.4 — Anthropic LLM client · _PR-3b_ · `[x] DONE`

- **What:** `LLMClient` interface (`complete(prompt): Promise<RiskVerdict>`) with a
  single `AnthropicClient` implementation using `@anthropic-ai/sdk`. JSON output per
  SPEC §3.2; thin interface kept only so tests can inject a mock.
- **Goal:** a typed, mockable LLM call; never the last line of defense.
- **Test:** Vitest with a mocked client: contract tests pass; on API error the caller
  falls back to the deterministic allocation (SPEC §3.5).

### 3.5 — LLM rationale + signal layer (news/attestation hero path) · _PR-3b_ · `[x] DONE`

- **What:** fetch unstructured items (Ondo attestation PDFs, AUSD PoR reports,
  regulatory/issuer news); pass structured market state + fetched items to the LLM
  via SPEC §3.1 prompt; parse + validate the `{rationale, riskVerdict}` JSON response.
  The LLM verdict may only **tighten** risk, never exceed guardrails. **This is the
  path the demo is built around — an AI that reads a document or headline that a
  pure threshold would miss.**
- **Goal:** human-readable rationale + a bounded verdict triggered by unstructured input.
- **Test:** Vitest with mocked LLM: schema validation; malformed output rejected;
  verdict clamped to safe bounds; an injected "issuer downgrade" headline tightens
  the verdict vs the deterministic baseline.

### 3.6 — Guardrail validator · _PR-3b_ · `[x] DONE`

- **What:** TS mirror of on-chain guardrails; validates/repairs the final proposal
  before signing.
- **Goal:** never sign a tx that would revert on-chain.
- **Test:** Vitest: proposals violating each guardrail are rejected/repaired;
  property tests vs the on-chain bounds.

### 3.7 — Executor / signer · _PR-3c_ · `[x] DONE`

- **What:** build + sign `rebalance`/`deRisk` with ALLOCATOR key; optional 1delta
  swap route passed as adapter param (`minOut` enforced on-chain); IPFS-pin
  rationale/evidence; write `AgentBenchmark` outcome + passive-USDY baseline delta.
- **Goal:** agent executes a rebalance end-to-end on the fork.
- **Test:** integration vs anvil fork: one agent run emits an on-chain `Decision`;
  weights change within guardrails.

### 3.8 — Scheduler + event triggers · _PR-3c_ · `[x] DONE`

- **What:** periodic loop + event triggers (poll depeg/oracle/utilization → immediate
  `deRisk` on breach); integrate demo-trigger harness for fork-injectable conditions.
- **Goal:** autonomous loop reacting to a simulated de-risk within one cycle.
- **Test:** integration: use demo-trigger harness → agent fires `deRisk` → on-chain
  USDY = 0; news/attestation path demonstrated end-to-end.

**Exit:** autonomous detect→de-risk loop on fork, triggered by injected news/attestation
signal; passive-baseline delta recorded on-chain.

---

## Phase 4 — ERC-8004 + frontend

**Phase goal:** register the agent identity; ship a React app (dashboard,
risk-guardian feed, identity card, deposit/withdraw) on testnet.

### 4.1 — ERC-8004 identity · _PR-4a_ · `[x] DONE` · [PR #12](https://github.com/0xMaxyz/miu/pull/12)

- **What:** register agent in 0x8004 Identity/Reputation registries if on Mantle;
  else deploy minimal Identity + Reputation registries and register; reputation hook
  writes decision outcomes.
- **Goal:** the agent has an on-chain identity NFT + reputation surface.
- **Test:** fork/testnet test: register → `tokenURI` resolves to the agent card;
  reputation entry writable & access-gated.
- **Built — canonical (production) path:** `interfaces/IERC8004Canonical.sol` mirrors
  the REAL deployed Mantle singletons (identity `register/setAgentURI/tokenURI/
  ownerOf/getAgentWallet`; reputation `giveFeedback/readFeedback/getLastIndex/
  getSummary/getIdentityRegistry`). `ForkPhase4a.t.sol` proves it on a Mantle fork:
  `register → tokenURI` round-trips, non-owner cannot `setAgentURI`, `giveFeedback →
  readFeedback/getSummary` round-trips, reputation links to the canonical identity.
  (Fork suite is skipped in CI like all `Fork*` tests; needs an allowlisted Mantle RPC.)
- **Built — fallback path:** `interfaces/IERC8004.sol` (simplified subset).
  `SentinelIdentityRegistry` (ERC721URIStorage; `register` mints the next sequential id
  to the caller, owner-only `setAgentURI`, `tokenURI` resolves the card) — note the
  canonical identity is ABI-compatible for this subset. `SentinelReputationRegistry`
  (role-gated `appendFeedback`, agent ids validated, zero-addr guard) is used only when
  the canonical singleton is absent. `Phase4a.t.sol` — 10 offline tests.
- **Decision:** SPEC §2.5 updated — production calls the canonical 0x8004 singletons;
  `Sentinel*` are the fallback. Canonical reputation uses `giveFeedback` (richer,
  client-keyed), not the simplified `appendFeedback`.

### 4.2 — Agent card + metadata · _PR-4a_ · `[x] DONE` · [PR #12](https://github.com/0xMaxyz/miu/pull/12)

- **What:** agent registration JSON (name, description, endpoints, wallet) pinned to
  IPFS; linked from identity.
- **Goal:** a resolvable, schema-valid agent card.
- **Test:** Vitest: fetched `tokenURI` JSON validates against the expected schema.
- **Built:** `agent/src/identity/agentCard.ts` — zod `agentCardSchema`
  `{ schemaVersion, name, description, endpoints, wallet, supportedTrust, vault,
  benchmark }`, `buildAgentCard()` (checksums addresses, validates before returning,
  fails loudly on missing vault/benchmark), `pinAgentCard()` reusing the shared
  `pinJson` IPFS helper (data: URI fallback). 10 Vitest cases.

### 4.3 — Web scaffold + chain config · _PR-4b_ · `[x] DONE` (PR #11)

- **What:** Vite React app, Tailwind+daisyUI theme, wagmi/viem wallet connect,
  Mantle mainnet+testnet config.
- **Goal:** app connects a wallet and reads the vault.
- **Test:** Vitest component render with mocked reads; manual connect on testnet.
- **Built:** wagmi + RainbowKit + react-query providers (`providers.tsx`), Mantle
  5000/5003 chain config with env-overridable RPC (`lib/chains.ts`), topbar
  `ConnectButton` (connect/account/chain-switch + wrong-network guard). Vitest
  covers chain config + format/fixture logic (25 tests).

### 4.4 — Dashboard (reads) · _PR-4b_ · `[x] DONE` (testnet live reads wired in 5.1; mainnet on 5.2)

- **What:** balance, share price, blended APY, allocation breakdown
  (USDY/Aave/idle/AUSD), TVL.
- **Goal:** an accurate live view from chain.
- **Test:** Vitest with mocked viem reads → expected figures; manual vs testnet.
- **Status:** dashboard renders the full layout behind a reads-hook seam
  (`lib/useVaultData.ts`). **Live on-chain reads are now wired** against the Mantle
  Sepolia (5003) deploy from task 5.1 (`useVaultData`/`useGuardianData` read the
  deployed `YieldVault`/`Guardrails`/`AgentBenchmark` from `packages/shared/deployments`);
  the fixture path remains the fallback when no deployment/RPC is configured. Mainnet
  reads switch on automatically once 5.2 records the 5000 addresses; consumers unchanged.

### 4.5 — Deposit/withdraw flow · _PR-4c_ · `[x] DONE`

- **What:** approve+deposit, withdraw/redeem, tx status, testnet/mainnet toggle.
- **Goal:** user deposits/withdraws on testnet.
- **Test:** manual e2e on testnet; component tests for the tx state machine.
- **Built:** `lib/txMachine.ts` — pure, tested deposit/withdraw logic:
  `previewDeposit`/`previewWithdraw` (guardrail-mirrored per-tx/capacity/balance/
  position caps, shares↔USDC conversion, instant-liquidity flag, `maxDepositable`)
  and the approve→deposit machine (`nextDepositPhase`/`depositStepIndex`/
  `isDepositBusy`/`failDeposit`). `TradeModals` refactored onto it. 18 Vitest cases.
  Live wallet writes (wagmi `useWriteContract`) land with the testnet deploy.

### 4.6 — Risk-guardian feed + decision detail · _PR-4c_ · `[x] DONE` (fixtures; live indexing deferred)

- **What:** timeline of `Decision` events with rationale + evidence (resolve IPFS);
  decision-detail view.
- **Goal:** the transparency hero view.
- **Test:** Vitest with mocked events/IPFS; manual vs real testnet decisions.
- **Built:** `lib/decisionUri.ts` — resolve a `decisionURI` (`ipfs://` → gateway,
  `data:`/`http(s)` passthrough, inline-JSON decode) with 9 tests; wired into
  `DecisionDetailModal`'s bundle link (hidden when unresolvable). `useDecisions`/
  `useDecision` seam (`lib/useGuardianData.ts`) feeds `ActivityPage`. Live
  `DecisionRecorded`/`OutcomeUpdated` event indexing **deferred** until the vault +
  AgentBenchmark deploy (no contract to index yet); consumers unchanged.

### 4.7 — Baseline counter · _PR-4c_ · `[x] DONE` (fixtures; live `AgentBenchmark` deferred)

- **What:** UI widget showing "Sentinel vs passive USDY holder" — running bps delta
  since the last de-risk event; pulled from `AgentBenchmark` baseline data.
- **Goal:** the Turing Test answer visible to anyone visiting the app.
- **Test:** Vitest mocked; correct delta rendered; manual vs testnet.
- **Built:** `lib/baseline.ts` — `computeBaseline` (per-point Sentinel−passive
  spread, latest delta, peak, ahead/behind, empty-series fallback) + `formatDeltaPct`.
  Consumed by the **Dashboard** `BaselineCounter` (headline derived from the series
  via `computeBaseline`, not the raw `passiveDeltaBps`) and also exposed on
  `useIdentity().baseline`. 8 tests incl. a canonical-fixture cross-check.

### 4.8 — Identity card · _PR-4c_ · `[x] DONE` (fixtures; live registry reads deferred)

- **What:** show the ERC-8004 NFT + track record (decisions handled, de-risk events,
  realized yield vs passive).
- **Goal:** verifiable agent reputation surfaced in the UI.
- **Test:** Vitest mocked; manual.
- **Built:** `useIdentity` seam (`lib/useGuardianData.ts`) feeds `AgentPage`'s
  identity card. Live `tokenURI`/`getAgentWallet` (canonical IdentityRegistry) +
  AgentBenchmark track-record reads **deferred** to the deploy wiring (PR-5a).

**Exit:** clickable end-to-end app on testnet with baseline counter visible.
**Status:** app is clickable on fixtures end-to-end (deposit/withdraw machine, decision
feed + detail, baseline counter, identity card). The remaining live-chain reads/writes
across 4.4/4.6/4.7/4.8 share one dependency — a deployed vault + AgentBenchmark +
ERC-8004 registration on testnet — and land with PR-5a's deploy wiring behind the
existing `use*Data` seams (consumers unchanged).

---

## Phase 5 — Mainnet (Core) + Addendum

### Phase 5a — Mainnet deploy (Core) · _PR-5a_

**Phase goal:** deploy + verify on mainnet; prove the full loop with small real funds.

### 5.1 — Deploy scripts · _PR-5a_ · `[x] DONE` · [PR #14](https://github.com/0xMaxyz/miu/pull/14)

- **What:** `forge script` deploy (vault, adapters, guardrails, benchmark, identity),
  parameterized; save addresses to `packages/shared` + `deployments.json`.
- **Goal:** reproducible deploy.
- **Test:** deploy to **Mantle testnet** ✓ — contracts live on Mantle Sepolia (5003).
- **Testnet addresses (2026-06-01):**
  - Guardrails:     `0xc3D287D35DCb6945d93c246dbE610C9AF5106E9c`
  - YieldVault:     `0xC2009De9C72EfAfAeeD8Ceac2960A9B6eFEeAc85`
  - AgentBenchmark: `0xCd3EcF4d092eE73Ac4882c61b5f114588B6B122a`
  - UsdyAdapter:    `0xd420Bdf2a7eab8F86DE12f06728342b7243101C9`
  - USDC (mock):    `0x6969D583f2b2e68c2f6f1A2E883aeC4dA96A3297`
  - USDY (mock):    `0x921689faCB514812F671194Db21014109354B5f6`
  - AaveV3Adapter: skipped (no Aave pool on Mantle Sepolia)
- **Built:** `contracts/script/Deploy.s.sol` — Guardrails → YieldVault → AgentBenchmark →
  AaveV3Adapter → UsdyAdapter → roles; on testnet zeroes `addStrategyTimelock` before
  queuing so `activateStrategy` succeeds in the same broadcast. `DeployMocks.s.sol`,
  `RegisterIdentity.s.sol`, `ActivateStrategies.s.sol`. `deployments/5003.json` +
  `packages/shared/src/deployments.ts` populated. Web `useVaultData` / `useGuardianData`
  live reads wired; 64 web tests + 103 Solidity tests pass.

### 5.2 — Mainnet deploy + verify · _PR-5a_ · `[ ]` pending RPC + keys

- **What:** deploy to **Mantle mainnet**; verify all contracts on mantlescan; set
  roles; conservative guardrail config.
- **Goal:** verified contracts live; AI `rebalance` callable on-chain.
- **Test:** mantlescan shows "verified"; `cast call` reads; a tiny rebalance tx
  succeeds -> Deployment-Award bars start ticking.

### 5.3 — Real-funds smoke test · _PR-5a_ · `[ ]` pending deploy

- **What:** deposit small USDC; agent runs one cycle (USDY + Aave); trigger a
  controlled de-risk using the demo-trigger harness; withdraw.
- **Goal:** full loop proven with real funds on mainnet; baseline counter updates.
- **Test:** recorded tx hashes; `Decision` events on mainnet; funds returned intact.

**Phase 5a exit:** live mainnet loop proven; Deployment-Award bars ticking. → **Core is done. Start Addendum only now.**

---

### Phase 5b — Addendum (time-permitting, in priority order) · _PR-A1, PR-A2, PR-A3_

Work through the Addendum list from §8 in order. Stop when time runs out. Each item is independent.

#### A1.1 — `AusdAdapter` · _PR-A1_ · `[x] DONE` · [PR #15](https://github.com/0xMaxyz/miu/pull/15)

- **What:** swap USDC↔AUSD; AUSD as safety bucket in de-risk.
- **Goal:** second safe bucket; de-risk can route to AUSD.
- **Test:** offline mock suite (`AusdAdapter.t.sol`, 21 tests) covers deposit/withdraw/
  emergency, balance-delta minOut, access control, and the vault de-risk USDY→AUSD path;
  `ForkPhaseA1.t.sol` covers live Mantle token/router presence + adapter construction.
  A live USDC→AUSD swap on a fork is deferred (needs Odos signed route calldata for the
  fork block — same caveat as `ForkPhase2a.t.sol` for USDY).
- **Built:** `contracts/src/AusdAdapter.sol` — same pinned-Odos-aggregator pattern as
  `UsdyAdapter` (balance-delta `minOut`, output must land on adapter), but AUSD is a
  fiat-backed $1 stablecoin valued **1:1 face** with USDC (no NAV oracle; depeg handled
  by the risk engine + Guardrails, per AGENTS.md §7). `YieldVault.deRisk` now routes the
  USDC freed from unwinding USDY into the AUSD bucket when `toBucket == AUSD` (via new
  `_unwindUsdyToAusd` helper; pre-existing idle USDC stays liquid). Deploy script wires
  bucket 3 (`AusdAdapter`); `deployments.ts`/JSON + `.env.example` (`TESTNET_AUSD`) updated.
  21 new unit tests; 124 offline Solidity tests pass.

#### A1.2 — AUSD proof-of-reserves signal · _PR-A1_ · `[x] DONE` (built in Phases 2–4)

- **What:** fetch AUSD PoR status (Chaos Labs); feed into risk engine + UI.
- **Goal:** AUSD PoR is a live risk input.
- **Test:** Vitest mocked; manual.
- **Built (already landed across earlier phases):** `OneDeltaClient.getAusdBackingRatioBps()`
  fetches the Chaos Labs PoR feed via 1delta (`/v1/mantle/ausd/por`), returning 0 = "unknown"
  on failure. `Snapshotter` caches it into `MarketSnapshot.ausdBackingRatioBps`; the
  deterministic risk engine raises `AUSD_POR_WARN` (→ CAUTION) when AUSD is held and backing
  < 99.5% (`AUSD_POR_MIN_BPS`). Agora PoR attestation is an evidence feed for the LLM path.
  UI surfaces it in `InsightsPage` (PoR ring). Covered by `oneDelta.test.ts`,
  `engine.test.ts`, `snapshot.test.ts` (122 agent Vitest pass).

#### A2.1 — Risk radar viz · _PR-A2_ · `[x] DONE`

- **What:** USDY peg (NAV vs spot), oracle freshness, AUSD PoR, Aave utilization charts.
- **Goal:** insight layer surfaced in the UI.
- **Test:** Vitest mocked; manual.
- **Built:** `GET /snapshot` in `agent/src/server.ts` returns the live
  `ExplainContext` (extended with `aaveWithdrawableUsdc` + `oracleRangeEnd`);
  `getContext` decoupled from the explainer so the route works without an
  Anthropic key (pipeline-only). Web `lib/useInsightsData.ts` polls `/snapshot`
  every 15s when `VITE_AGENT_API_URL` is set, falls back to fixture, and exposes
  a `stale` flag on fetch failure. `InsightsPage` renders live peg-deviation
  (severity-colored chip), oracle validity/days-remaining, AUSD PoR ratio+badge,
  and Aave utilization+APY+withdrawable; charts append a live current point; a
  freshness chip shows updated/stale/demo. 4 web Vitest (fixture fallback, live
  mapping, empty-range, error path); all suites green.
  · [PR #17](https://github.com/0xMaxyz/miu/pull/17)

#### A3.1 — Conversational agent · _PR-A3_ · `[x] DONE`

- **What:** Fastify endpoint + UI panel ("why am I in AUSD?", "what changed?").
- **Goal:** natural-language transparency.
- **Test:** Vitest mocked LLM; manual.
- **Built:** `agent/src/llm/explain.ts` — `buildExplainContext()` (pure: snapshot +
  assessment + recent decisions → compact grounding, bigints pre-formatted) and
  `AnthropicExplainer` (grounded Q&A, controls no funds, answers only from context).
  `POST /ask` in `server.ts` (injectable explainer + async `getContext`; 400 empty/long
  question, 503 no-state, 502 LLM error, 429 rate limit, permissive CORS; default
  30/min, `askRateLimit`/`askRateWindowMs`, 0 disables). `index.ts` wires the explainer,
  a 10s TTL snapshot-backed `getContext` (invalidated on new decisions), and a
  recent-decisions ring buffer (`CycleResult.decision` carries rationale/signals;
  executor tests lock rebalance + de-risk). Web `AgentPage` AskPanel calls the live
  endpoint via `lib/askAgent.ts` when `VITE_AGENT_API_URL` is set (threads `asOf`;
  shows grounding freshness under live answers), fixture answers otherwise. 16 new
  agent Vitest + 4 web Vitest (138 agent, 68 web); all suites green.
  · [PR #16](https://github.com/0xMaxyz/miu/pull/16)

#### A3.2 — Alerts · _PR-A3_ · `[x] DONE`

- **What:** Telegram/Discord webhook on de-risk events.
- **Goal:** off-platform transparency.
- **Test:** trigger event → message delivered.
- **Built:** `agent/src/alerts.ts` — `AlertNotifier` fires Telegram and/or Discord
  messages on de-risk decisions (injectable `fetch`; both channels optional;
  `Promise.allSettled` so delivery failures never crash the agent; plain-text body,
  no `parse_mode`, so `&`/`<`/`>` in rationale can't break delivery). Wired into the
  scheduler `onCycle` in `index.ts` (only `kind === "derisk"`; captures the cycle
  context **before** the decision-ring invalidation so flags/asOf are real). Config:
  `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` and/or `DISCORD_WEBHOOK_URL` (in
  `.env.example`). 11 agent Vitest (both channels, partial configs, failure path).
  · [PR #17](https://github.com/0xMaxyz/miu/pull/17)

#### A4.1 — Agent x402 micropayments · _PR-A4_ · `[x] DONE` · [PR #21](https://github.com/0xMaxyz/miu/pull/21)

- **What:** the agent pays per-call (x402, stablecoin) for premium risk/data feeds;
  the x402 receipt is pinned into the decision evidence bundle. Optionally expose
  Sentinel's RWA risk score as an x402-paid endpoint other agents can call.
- **Goal:** verifiable "the agent paid for the evidence it acted on", plus a revenue
  surface that justifies running a Sentinel agent.
- **Test:** Vitest mocked x402 flow; a decision links a valid x402 receipt; the paid
  endpoint returns 402 then 200 after payment.
- **Built:** `agent/src/payments/x402.ts` — Coinbase x402 "exact" EVM scheme (EIP-3009
  `transferWithAuthorization` signed via EIP-712): `createPayment`/`payAndFetch` (client
  pays on 402 and retries with a base64 `X-PAYMENT` header, returns the settlement
  receipt), `encode/decodePaymentHeader`/`decodeSettlement`, and an injectable
  `PaymentVerifier` (`shapeOnlyVerifier` for dev; facilitator/on-chain for prod —
  signing + settlement are injected so the protocol is testable offline). `server.ts`
  gains the **revenue surface** `GET /risk-score` (402 → `accepts[]`; 200 + score +
  `X-PAYMENT-RESPONSE` once paid). The decision bundle (`executor/ipfs.ts`
  `RationaleBundle.payments`) pins `{evidenceId, receipt}` so "paid-for evidence" is in
  the hashed/IPFS bundle. Config: optional `X402_*` (`config.ts` + `.env.example`).
  Tests: `x402.test.ts` (10) + `server.test.ts` x402 (3) — 402→pay→200, receipt binding,
  verifier accept/reject.
- **Follow-up (production verifier) · [PR #22](https://github.com/0xMaxyz/miu/pull/22):** `payments/verifier.ts` adds
  `signatureVerifyingVerifier` (recovers the EIP-712 signer via `recoverTypedDataAddress`
  and matches `from` — real authorization check) and `onChainSettlingVerifier` (verifies
  then settles via `transferWithAuthorization`, returning the real tx hash; gated by
  `X402_SETTLE_ONCHAIN` + an ALLOCATOR wallet). `index.ts` wires the strong verifier
  (no `shapeOnlyVerifier` in the running agent). The EIP-712 message now uses canonical
  `bigint` `uint256` fields (`eip3009TypedData`/`toEip3009Message`) so sign+recover are
  consistent. 7 `verifier.test.ts` cases (genuine sign→recover, tamper/expiry rejection,
  on-chain settle, fail-closed on a reverted settlement, no-settle-on-bad-sig).

#### A4.2 — ERC-8183 verifiable jobs · _PR-A4_ · `[x] DONE` · [PR #21](https://github.com/0xMaxyz/miu/pull/21)

- **What:** model each de-risk as an ERC-8183 escrowed Job (client/provider/
  evaluator); the **deterministic guardrail validator is the evaluator** that releases
  the Job only if guardrails pass; the outcome feeds ERC-8004 reputation.
- **Goal:** the LLM-proposes → validator-checks → guardrail-backstops pipeline encoded
  as a published standard; the agent accrues a verifiable risk-call record.
- **Test:** fork/unit: a passing de-risk Job settles + writes reputation; a
  guardrail-violating Job is rejected by the evaluator.
- **Built:** `interfaces/IERC8183.sol` (draft-spec subset: `JobStatus`
  Open/Funded/Submitted/Completed/Rejected/Expired, `Job`, `createJob/setProvider/
  setBudget/fund/submit/complete/reject/claimRefund/getJob` + events).
  `SentinelJobEscrow.sol` — USDC-escrowed jobs (client funds → provider submits →
  evaluator completes=pay provider / rejects=refund client; expiry refund), **not in the
  vault custody path** (escrows a per-job bounty, never user deposits). `SentinelDeRiskEvaluator.sol`
  — the **Evaluator is the deterministic guardrail check**: `evaluate(...)` calls
  `Guardrails.evaluateUsdyRisk(MarketState)` and `complete`s (+ writes
  ERC-8004 `appendFeedback`) only when `forceDeRisk`, else `reject`s; KEEPER-gated
  (the keeper supplies the same snapshot the vault's `deRisk` uses). Tests:
  `PhaseA4.t.sol` (12) — justified de-risk settles + writes reputation, unjustified is
  rejected + refunds, expiry refund, full access-control + state-machine guards.
- **UI surfaces (web/src) for A4 + the mUSD leg (per `UI.md`) · `[x] DONE` · [PR #23](https://github.com/0xMaxyz/miu/pull/23):** `Components.tsx` adds
  `PaidEvidenceBadge` (x402 receipt), `JobStatusChip` (ERC-8183 status), and
  `RwaFormSplit` (USDY/mUSD allocation sublabel). Wired in: Dashboard allocation card
  (RWA core form split), Activity decision item + detail (paid-evidence badges per
  cited evidence + a "Verifiable job · ERC-8183" section), and a new Agent-page
  **Agent economics** panel (sells `/risk-score`, paid evidence, the ERC-8183→ERC-8004
  jobs ledger — all labelled "outside custody"). Fixtures + 7 `data.test.ts` cases
  (form-split conservation, converter address, paid-receipt↔evidence linkage, job
  status/reputation). All on the existing fixture seams; live job/x402 indexing
  deferred with the other live reads.

**Phase 5b exit:** whatever shipped.

---

## Phase 6 — Freeze & polish (target 2026-06-12)

**Phase goal:** public deploy, docs, video, submission, marketing.

### 6.1 — Public frontend deploy (Docker/Caddy) · _PR-6a_

- **What:** containerize web + agent; Caddy reverse proxy + TLS; deploy to a host.
- **Goal:** a public URL (not localhost).
- **Test:** load public URL; deposit/withdraw works; perf sanity (Lighthouse).

### 6.2 — README + docs · _PR-6a_

- **What:** setup, architecture diagram, deployed addresses, `.env.example`, and the
  three submission answers (data sources / AI role / Mantle realization).
- **Goal:** a judge can run and understand it.
- **Test:** fresh-clone dry run following the README in a clean container.

### 6.3 — Demo video (≥2 min) · _PR-6a_

- **What:** script + screen+voiceover recording. Sequence: deposit → earning →
  **AI reads attestation/news signal** → de-risk fires (via demo-trigger harness) →
  on-chain decision with evidence → **baseline counter** ("passive holder: –X bps /
  Sentinel: avoided it") → identity card. Use the harness to fire the de-risk on cue.
- **Goal:** a compelling ≥2-min walkthrough that directly answers "can this AI beat
  a passive USDY holder at managing risk?"
- **Test:** review against the Deployment-Award + UI/UX criteria checklist; the hero
  moment (news → de-risk → baseline delta) must be clearly visible.

### 6.4 — Submission package · _PR-6a_

- **What:** DoraHacks submission: one-line pitch, repo, demo link, video, deployed
  address, track nomination, the three questions.
- **Goal:** a complete submission draft.
- **Test:** `PLAN.md` §11 checklist fully ticked; second reviewer pass.

### 6.5 — Community/marketing assets · _PR-6a_

- **What:** X thread, short clip, screenshots for Community Voting.
- **Goal:** shareable assets ready.
- **Test:** links live; thread renders.

**Exit:** feature-frozen, submission-ready package.

---

## Phase 7 — Buffer & contingency (2026-06-13/14)

### 7.1 — Bug bash · _PR-7_

- **What:** full Forge fork regression + agent e2e re-run; fix criticals.
- **Test:** all suites green.

### 7.2 — Submission dry-run · _PR-7_

- **What:** walk the judge path end-to-end from the public URL + README.
- **Test:** no blockers; checklist re-verified.

### 7.3 — Re-record / polish · _PR-7_

- **What:** re-record video or tighten UI if needed.
- **Test:** peer review.

### 7.4 — Contingency: AUSD-primary fallback · _PR-7_

- **What:** if USDY liquidity/oracle degrades, switch the yield core to AUSD-based
  strategy (Upshift/Aave) using the same vault/guardrails.
- **Test:** fork test of the fallback allocation; deploy switch documented.

---

## Dependency notes

- Phase 0 gates everything (esp. liquidity 0.4 → may force the AUSD-primary path).
- Phase 1 (vault + Aave) is the backbone; Phase 2 (USDY + guard) depends on it.
- Phase 3 (agent) needs Phase 2 contracts to drive; mock with the Phase-1 mock
  adapter until 2.x lands.
- Phase 4 frontend can start scaffolding (4.3) in parallel once Phase 1 is on
  testnet, but the risk-guardian feed (4.6) needs Phase 2 `Decision` events.
- ERC-8004 (4.1) can be done any time after Phase 0's registry decision.
