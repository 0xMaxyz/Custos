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
- Branch per PR: `cursor/<short-name>-46a8`. Keep `PLAN.md`/`ROADMAP.md` in sync if
  scope shifts.

## PR map (suggested)

| PR | Tasks | Theme |
|----|-------|-------|
| PR-0a | 0.1 | Monorepo scaffold |
| PR-0b | 0.2–0.5 | Fork harness + verification GATE |
| PR-1a | 1.1–1.4 | Roles, guardrails, vault skeleton, adapter interface |
| PR-1b | 1.5–1.6 | Aave adapter + rebalance/withdraw |
| PR-2a | 2.1–2.3 | DEX lib + USDY valuation + UsdyAdapter |
| PR-2b | 2.4–2.6 | Depeg/oracle guard + de-risk + decision ledger |
| PR-2c | 2.7 | AUSD adapter (Should) |
| PR-3a | 3.1–3.3 | Agent config + ingestion + deterministic risk engine |
| PR-3b | 3.4–3.5 | Anthropic API (Claude) rationale + guardrail validator |
| PR-3c | 3.6–3.7 | Executor/signer + scheduler + e2e on fork |
| PR-4a | 4.1–4.2 | ERC-8004 identity + agent card |
| PR-4b | 4.3–4.4 | Web scaffold + dashboard reads |
| PR-4c | 4.5–4.7 | Deposit/withdraw + risk-guardian feed + identity card |
| PR-4d | 4.8 | Risk radar viz (Should) |
| PR-5a | 5.1–5.2 | Deploy scripts + mainnet deploy + verify |
| PR-5b | 5.3 | Real-funds smoke test |
| PR-5c | 5.4–5.5 | Conversational agent + alerts (Should) |
| PR-6a | 6.1–6.5 | Public deploy, docs, video, submission |
| PR-7  | 7.1–7.4 | Buffer / contingency |

---

## Phase 0 — Foundations & Gates

**Phase goal:** repo scaffolding + a Mantle mainnet-fork harness, and **prove every
external dependency exists and is usable.** This is a go/no-go gate; if the
liquidity gate fails, switch to the AUSD-primary fallback before Phase 1.

### 0.1 — Monorepo scaffold · _PR-0a_
- **What:** workspace layout `/contracts` (Foundry), `/agent` (Node/TS + Fastify),
  `/web` (React/Vite/Tailwind/daisyUI), `/packages/shared` (types + addresses);
  root tooling (workspaces, eslint, prettier, base tsconfig), `.gitignore`
  (`.env`, `out`, `broadcast`, `cache`, `node_modules`), `.env.example`,
  `docker-compose.yml` + `Caddyfile` skeletons.
- **Goal:** a clean clone builds/typechecks across all packages.
- **Test:** `forge build`, `pnpm -r typecheck`, `pnpm -r lint`, and
  `docker compose config` all succeed; CI script documented.

### 0.2 — Mantle fork test harness · _PR-0b_
- **What:** Foundry fork profile using `MANTLE_RPC_URL` at a pinned block; base test
  utilities (token labels, `deal`-via-swap helper).
- **Goal:** tests run against a deterministic Mantle mainnet fork.
- **Test:** `forge test --fork-url $MANTLE_RPC_URL --match-test testForkSanity`
  asserts `block.chainid == 5000` and reads `USDC.decimals() == 6`.

### 0.3 — On-chain address & capability verification (GATE) · _PR-0b_
- **What:** resolve + verify and record in `packages/shared/addresses.ts`
  (with "verified @ block N"): USDC; USDY + `RWADynamicOracle`; AUSD; Aave v3
  `Pool` + `PoolDataProvider` + aUSDC; DEX router(s) for USDY/USDC, USDY/WMNT,
  AUSD pairs; ERC-8004 Identity/Reputation registries (present on Mantle?).
- **Goal:** a committed, verified registry; explicit decision on ERC-8004
  (use 0x8004 singletons vs deploy our own).
- **Test:** fork test asserts `extcodesize > 0` for each address and a basic call
  per interface succeeds (`oracle` returns price; `Pool.getReserveData(USDC)`
  returns aToken; router quote returns > 0).

### 0.4 — Liquidity & swap-quote gate · _PR-0b_
- **What:** quote USDC→USDY, USDC→AUSD, and reverse at $100 / $1k / $10k on the
  chosen router on the fork; record slippage.
- **Goal:** documented slippage table + a GO decision (e.g. ≤0.5% at $1k) or trigger
  the **AUSD-primary fallback**.
- **Test:** fork test executes swaps, asserts `received >= minOut` for the target
  slippage, and logs the table.

### 0.5 — USDY transfer-hook (blocklist) check · _PR-0b_
- **What:** confirm a fresh contract can receive/hold/transfer USDY (not blocked);
  characterize `beforeTransfer` behavior.
- **Goal:** confirmation the vault can custody USDY.
- **Test:** fork test swaps USDC→USDY into a test contract, transfers out, asserts
  success and `Blocklist.isBlocked(testContract) == false`.

**Exit:** scaffold builds; fork tests read Aave/USDY/AUSD; liquidity GO (or fallback
chosen); ERC-8004 path decided.

---

## Phase 1 — Vault core (no RWA yet)

**Phase goal:** a working ERC-4626 USDC vault with the Aave leg, idle buffer,
guardrails, and deposit/withdraw.

### 1.1 — Roles & access control · _PR-1a_
- **What:** `ADMIN`, `ALLOCATOR`, `GUARDIAN` roles; `Pausable`; kill switch.
- **Goal:** only ALLOCATOR rebalances; GUARDIAN can pause; ADMIN manages config.
- **Test:** Forge unit tests: unauthorized calls revert; pause blocks
  deposit/rebalance; kill switch enables emergency withdraw-only.

### 1.2 — Guardrails module · _PR-1a_
- **What:** params: `maxWeightPerBucket`, `minLiquidityBufferBps`, `maxSlippageBps`,
  token/venue whitelist, `maxRebalanceFreq`, `perTxCap`, `addStrategyTimelock`;
  pure validation helpers.
- **Goal:** a module the vault consults to accept/reject a proposed allocation.
- **Test:** Forge unit tests: over-cap/over-slippage/non-whitelisted proposals
  revert; within-bounds pass; timelock enforced for new strategies.

### 1.3 — `YieldVault` ERC-4626 skeleton · _PR-1a_
- **What:** USDC asset; deposit/mint/withdraw/redeem; `totalAssets()` = idle +
  Σ adapter assets; idle-buffer accounting; reentrancy guards.
- **Goal:** deposit/withdraw works with idle-only; share math correct.
- **Test:** Forge: deposit→redeem round-trip; `totalAssets` tracks; fuzz that share
  price is non-decreasing absent losses.

### 1.4 — Strategy adapter interface · _PR-1a_
- **What:** `IStrategyAdapter` (`deposit`, `withdraw`, `totalAssets`,
  `maxWithdrawable`); vault registry of adapters + target weights.
- **Goal:** pluggable adapters behind a stable interface.
- **Test:** Forge: a mock adapter; vault allocates/deallocates to it; invariants hold.

### 1.5 — `AaveV3Adapter` · _PR-1b_
- **What:** supply/withdraw USDC on Aave v3 Mantle; `totalAssets` = aUSDC balance;
  `maxWithdrawable` = available pool liquidity.
- **Goal:** vault can route idle USDC to Aave and pull it back.
- **Test:** fork test: deposit → allocate to Aave → `warp` → aUSDC grew →
  full withdraw returns ≥ principal.

### 1.6 — `rebalance()` + withdraw queue · _PR-1b_
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

### 2.1 — DEX swap library · _PR-2a_
- **What:** minimal `exactIn` swap wrapper for the chosen Mantle router with
  `minOut` + `deadline`; configured paths USDC↔USDY, USDC↔AUSD.
- **Goal:** trustless swaps with on-chain slippage protection.
- **Test:** fork test: USDC→USDY→USDC respects `minOut`; slippage within guardrail.

### 2.2 — USDY valuation via `RWADynamicOracle` · _PR-2a_
- **What:** read USDY NAV for valuation; staleness check (timestamp/round).
- **Goal:** vault values USDY by oracle NAV; detects stale oracle.
- **Test:** fork test: USDY holdings valued at oracle price; simulated stale oracle
  flips the staleness flag.

### 2.3 — `UsdyAdapter` · _PR-2a_
- **What:** allocate = swap USDC→USDY (`minOut`); withdraw = swap USDY→USDC
  (`minOut`); `totalAssets` via oracle; `maxWithdrawable` via liquidity cap;
  blocklist-aware.
- **Goal:** USDY is a managed bucket the vault can enter/exit.
- **Test:** fork test: rebalance into USDY; `totalAssets` stable; withdraw unwinds
  USDY→USDC ≥ `minOut`.

### 2.4 — Depeg / oracle-deviation guard · _PR-2b_
- **What:** on-chain guard comparing USDY DEX spot vs oracle NAV (deviation bps) +
  staleness; on breach, block new USDY allocation and allow/force de-risk.
- **Goal:** deterministic on-chain trigger gating USDY exposure.
- **Test:** fork test with mocked router spot (or a depeg block): guard flips and
  new USDY allocation reverts; normal conditions pass.

### 2.5 — De-risk path · _PR-2b_
- **What:** `deRisk()` (ALLOCATOR/GUARDIAN) rotates USDY→USDC/AUSD; emits `Decision`
  with `reason` + `evidenceHash`.
- **Goal:** one call exits USDY to safety, logged with evidence.
- **Test:** fork test: trip guard → `deRisk` → USDY balance 0, safe bucket up,
  `Decision` carries evidence fields.

### 2.6 — `AgentBenchmark` ledger · _PR-2b_
- **What:** record each decision (pre/post weights, `rationaleHash`, `evidenceURI`,
  timestamp); `updateOutcome()` writes realized APY / drawdown-avoided later.
- **Goal:** verifiable on-chain decision + outcome ledger.
- **Test:** Forge: events emitted with expected fields; `updateOutcome` access-gated
  and stored.

### 2.7 — `AusdAdapter` (Should) · _PR-2c_
- **What:** swap USDC↔AUSD; AUSD as safety bucket; optionally read proof-of-reserves
  status.
- **Goal:** a second safe bucket for de-risk.
- **Test:** fork test: allocate to AUSD and withdraw back.

**Exit:** a USDY→safe rotation emits a verifiable on-chain decision with evidence.

---

## Phase 3 — AI agent (off-chain)

**Phase goal:** the Fastify service: ingest data → deterministic risk engine →
Anthropic API (Claude) rationale → guardrail validator → signer → scheduler, driving the contracts on
a fork.

### 3.1 — Config & types · _PR-3a_
- **What:** shared types (`Allocation`, `RiskSignal`, `Decision`); env/config loader;
  viem clients (read + ALLOCATOR signer); pull addresses from `packages/shared`.
- **Goal:** typed, validated foundation.
- **Test:** Vitest: config loader rejects missing/invalid env; type/unit tests.

### 3.2 — Data ingestion (read) · _PR-3a_
- **What:** 1delta client (Aave pools/IRM/yields, Mantle) + RPC readers (USDY NAV +
  DEX spot, Aave reserve data, AUSD PoR); caching layer.
- **Goal:** a `snapshot()` returning all market + risk inputs.
- **Test:** Vitest with mocked HTTP/RPC for shape + cache TTL; one integration test
  against a local fork.

### 3.3 — Deterministic risk engine · _PR-3a_
- **What:** pure functions: yield spread (USDY-implied APY vs Aave supply APY), peg
  deviation bps, oracle staleness, buffer requirement, constrained target-weight
  proposer.
- **Goal:** snapshot → candidate allocation + risk flags, deterministically.
- **Test:** Vitest table-driven (normal / depeg / stale / low-liquidity) → expected
  weights & flags; pure, no network.

### 3.4 — Anthropic API (Claude) rationale + signal layer · _PR-3b_
- **What:** Anthropic API (Claude) client; prompt taking structured inputs + fetched unstructured
  items (attestation/news) → JSON `{rationale, riskVerdict}` (schema-validated). The
  LLM verdict may only **tighten** risk, never exceed guardrails.
- **Goal:** human-readable rationale + a bounded verdict.
- **Test:** Vitest with mocked Anthropic API (Claude): schema validation; malformed output rejected;
  verdict clamped to safe bounds.

### 3.5 — Guardrail validator · _PR-3b_
- **What:** TS mirror of on-chain guardrails; validates/repairs the final proposal
  before signing.
- **Goal:** never sign a tx that would revert on-chain.
- **Test:** Vitest: proposals violating each guardrail are rejected/repaired;
  property tests vs the on-chain bounds.

### 3.6 — Executor / signer · _PR-3c_
- **What:** build + sign `rebalance`/`deRisk` with ALLOCATOR key; optional 1delta
  swap route passed as adapter param (`minOut` enforced on-chain); IPFS-pin
  rationale/evidence; write `AgentBenchmark` outcome.
- **Goal:** agent executes a rebalance end-to-end on the fork.
- **Test:** integration vs anvil fork: one agent run emits an on-chain `Decision`;
  weights change within guardrails.

### 3.7 — Scheduler + event triggers · _PR-3c_
- **What:** periodic loop + event triggers (poll depeg/oracle/utilization → immediate
  `deRisk` on breach).
- **Goal:** autonomous loop reacting to a simulated depeg within one cycle.
- **Test:** integration: inject depeg (mock spot on fork) → agent fires `deRisk` →
  on-chain USDY = 0.

**Exit:** end-to-end autonomous detect→de-risk loop on fork.

---

## Phase 4 — ERC-8004 + frontend

**Phase goal:** register the agent identity; ship a React app (dashboard,
risk-guardian feed, identity card, deposit/withdraw) on testnet.

### 4.1 — ERC-8004 identity · _PR-4a_
- **What:** register agent in 0x8004 Identity/Reputation registries if on Mantle;
  else deploy minimal Identity + Reputation registries and register; reputation hook
  writes decision outcomes.
- **Goal:** the agent has an on-chain identity NFT + reputation surface.
- **Test:** fork/testnet test: register → `tokenURI` resolves to the agent card;
  reputation entry writable & access-gated.

### 4.2 — Agent card + metadata · _PR-4a_
- **What:** agent registration JSON (name, description, endpoints, wallet) pinned to
  IPFS; linked from identity.
- **Goal:** a resolvable, schema-valid agent card.
- **Test:** Vitest: fetched `tokenURI` JSON validates against the expected schema.

### 4.3 — Web scaffold + chain config · _PR-4b_
- **What:** Vite React app, Tailwind+daisyUI theme, wagmi/viem wallet connect,
  Mantle mainnet+testnet config.
- **Goal:** app connects a wallet and reads the vault.
- **Test:** Vitest component render with mocked reads; manual connect on testnet.

### 4.4 — Dashboard (reads) · _PR-4b_
- **What:** balance, share price, blended APY, allocation breakdown
  (USDY/Aave/idle/AUSD), TVL.
- **Goal:** an accurate live view from chain.
- **Test:** Vitest with mocked viem reads → expected figures; manual vs testnet.

### 4.5 — Deposit/withdraw flow · _PR-4c_
- **What:** approve+deposit, withdraw/redeem, tx status, testnet/mainnet toggle.
- **Goal:** user deposits/withdraws on testnet.
- **Test:** manual e2e on testnet; component tests for the tx state machine.

### 4.6 — Risk-guardian feed + decision detail · _PR-4c_
- **What:** timeline of `Decision` events with rationale + evidence (resolve IPFS);
  decision-detail view.
- **Goal:** the transparency hero view.
- **Test:** Vitest with mocked events/IPFS; manual vs real testnet decisions.

### 4.7 — Identity card · _PR-4c_
- **What:** show the ERC-8004 NFT + track record (decisions handled, de-risk events,
  realized yield).
- **Goal:** verifiable agent reputation surfaced in the UI.
- **Test:** Vitest mocked; manual.

### 4.8 — Risk radar viz (Should) · _PR-4d_
- **What:** USDY peg (NAV vs spot), oracle freshness, AUSD PoR, Aave utilization
  charts.
- **Goal:** the insight layer (absorbs the Option-B value).
- **Test:** Vitest mocked; manual.

**Exit:** clickable end-to-end app on testnet.

---

## Phase 5 — Mainnet + Should-haves

**Phase goal:** deploy + verify on mainnet, prove the loop with small real funds, add
the AUSD leg + conversational agent + alerts.

### 5.1 — Deploy scripts · _PR-5a_
- **What:** `forge script` deploy (vault, adapters, guardrails, benchmark, identity),
  parameterized; save addresses to `packages/shared` + `deployments.json`.
- **Goal:** reproducible deploy.
- **Test:** deploy to **Mantle testnet**; assert code at addresses; run a smoke
  rebalance.

### 5.2 — Mainnet deploy + verify · _PR-5a_
- **What:** deploy to **Mantle mainnet**; verify all contracts on mantlescan; set
  roles; conservative guardrail config.
- **Goal:** verified contracts live; AI `rebalance` callable on-chain.
- **Test:** mantlescan shows "verified"; `cast call` reads; a tiny rebalance tx
  succeeds → Deployment-Award bars start ticking.

### 5.3 — Real-funds smoke test · _PR-5b_
- **What:** deposit small USDC; agent runs one cycle (USDY + Aave); trigger a
  controlled de-risk; withdraw.
- **Goal:** full loop proven with real funds on mainnet.
- **Test:** recorded tx hashes; `Decision` events on mainnet; funds returned intact.

### 5.4 — Conversational agent (Should) · _PR-5c_
- **What:** Fastify endpoint + UI panel ("why am I in AUSD?", "what changed?") over
  decision history + snapshot.
- **Goal:** natural-language transparency.
- **Test:** Vitest mocked LLM; manual.

### 5.5 — Alerts (Should) · _PR-5c_
- **What:** Telegram/Discord webhook on de-risk events.
- **Goal:** off-platform transparency + reach.
- **Test:** trigger event → message delivered; unit test for the formatter.

**Exit:** live mainnet demo.

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
- **What:** script + screen+voiceover recording: deposit → earning → **live de-risk
  event** → on-chain decision + identity.
- **Goal:** a compelling ≥2-min walkthrough.
- **Test:** review against the Deployment-Award + UI/UX criteria checklist.

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
