# Custos — Deployment Guide (mainnet + testnet)

End-to-end runbook for deploying the full stack: contracts, ERC-8004 identity,
backend agent, frontend, and the Caddy reverse proxy. Written for Mantle mainnet
(chainId 5000); testnet (5003) differences are called out inline.

> **Read first:** `docs/agents.md` §2 (non-negotiables), `docs/spec.md` §1 (guardrail
> parameters & roles). Never commit secrets; everything sensitive lives in a
> git-ignored `.env` (template: `.env.example`).

---

## 0. Prerequisites

**Tooling**

- Foundry (`forge`, `cast`, `anvil`) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Node 22+ and pnpm 9 (`corepack enable`)
- Docker + Docker Compose (for the agent/web/caddy stack)
- A server (or local box) that can run Docker and is reachable on 80/443 if you want public access

**Accounts & keys** (all referenced from `.env`; see `.env.example` for every variable)

| What | Env var | Notes |
|---|---|---|
| Deployer EOA | `DEPLOYER_PRIVATE_KEY` | Funds: ~2–5 MNT for gas. Used ONLY to deploy; on mainnet it renounces all admin at the end of the script (H4). |
| Admin multisig | `ADMIN_ADDRESS` | **Required on mainnet, must differ from deployer.** Create a [Safe](https://safe.global) on Mantle first (2/3 recommended). Receives `DEFAULT_ADMIN_ROLE` + `ADMIN` on Guardrails, YieldVault, AgentBenchmark. |
| Allocator hot key | `ALLOCATOR_PRIVATE_KEY` / `ALLOCATOR_ADDRESS` | The agent's tx signer. Guardrail-bounded; fund with a small amount of MNT (it only pays gas). Use a dedicated fresh key, never the deployer. |
| Guardian | `GUARDIAN_ADDRESS` | Can `pause`/`unpause`/`kill`/`emergencyExit`. Recommended: the Safe, or a hardware-wallet EOA that is NOT the allocator. |
| Anthropic API | `ANTHROPIC_API_KEY` | LLM signal layer + `/ask`. Agent degrades gracefully (deterministic-only) without it, but the hero path needs it. |
| 1delta API | `ONEDELTA_API_KEY` | Data + swap routing/quoting only (never custody). From auth.1delta.io. |
| Mantlescan | `MANTLESCAN_API_KEY` | Contract verification. |
| IPFS pinning | `IPFS_API_URL` / `IPFS_PINNING_JWT` | Optional — falls back to `data:` URIs. Pinata or a Kubo node. |
| WalletConnect | `VITE_WALLETCONNECT_PROJECT_ID` | Optional for injected-only wallets. |
| Alerts | `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` and/or `DISCORD_WEBHOOK_URL` | **Strongly recommended on mainnet** — de-risk success AND failure alerts (O1) are wired through these. |

**Funding for the demo/smoke tests:** a small amount of USDC on Mantle (e.g. $100–500)
on a separate test-user wallet for deposits.

---

## 1. Phase 0 — verify external addresses on-chain

Per `docs/agents.md` §2.6, treat every external address as unverified until confirmed.
The canonical set lives in `packages/shared/src/addresses.ts`; cross-check each against
Mantlescan before broadcasting anything:

```bash
RPC=https://rpc.mantle.xyz
# USDY oracle is live and returns a sane NAV (18-dec, ~1.0x):
cast call <USDY_ORACLE> "getPrice()(uint256)" --rpc-url $RPC
# mUSD converter wiring: usdy() and oracle() must match the pinned addresses:
cast call <MUSD> "usdy()(address)" --rpc-url $RPC
cast call <MUSD> "oracle()(address)" --rpc-url $RPC
# Aave v3 pool resolves from the PoolAddressesProvider (the script does this too):
cast call <AAVE_PROVIDER> "getPool()(address)" --rpc-url $RPC
# Odos router (USDY_AGGREGATOR_ROUTER): confirm it is the canonical Odos router on Mantle.
```

Also sanity-check that the **ERC-8004 canonical singletons** exist on Mantle
(`0x8004A169…a432` Identity, `0x8004BAa1…9b63` Reputation — see `docs/architecture.md` §5).

---

## 2. Fork rehearsal (mandatory before mainnet)

Always rehearse the exact broadcast against a fork first:

```bash
anvil --fork-url $MANTLE_RPC_URL --chain-id 5000 &
export MAINNET_FORK=http://127.0.0.1:8545

cd contracts
forge script script/Deploy.s.sol --rpc-url $MAINNET_FORK \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
```

The fork run must show, in order: Guardrails → setConfig bootstrap → YieldVault →
AgentBenchmark → adapters deployed and **queued** (not active — the timelock floor
means activation is a later step) → ALLOCATOR/GUARDIAN grants → **admin handoff to
`ADMIN_ADDRESS` + deployer renounce**. If the handoff lines don't print, stop and fix
your env before touching mainnet.

Run the fork test suites too:

```bash
forge test                       # includes Fork*.t.sol when MANTLE_RPC_URL is set
pnpm -r test                     # agent + shared + web unit tests
```

---

## 3. Contracts — mainnet deploy

### 3.1 Decide the launch timelock (v1 guarded launch)

`Guardrails.addStrategyTimelock` gates adapter activation **and** every post-bootstrap
config/guardrails change. The on-chain floor is `MIN_TIMELOCK = 1h` (M5); the default
is 48h. For the first mainnet window we recommend a short delay so operational fixes
don't take two days, then raising it:

```bash
# .env — guarded-launch window (6h). Unset/0 keeps the 48h default.
INITIAL_TIMELOCK_SECONDS=21600
```

This is only acceptable because (a) admin is a multisig from block one (H4), (b) TVL
is capped at $50k with $10k/tx, and (c) `ConfigQueued` events are watched (see §8).
**Schedule the raise back to 172800 (48h) as part of launch — see §3.5.**

### 3.2 Broadcast

```bash
# .env must have: DEPLOYER_PRIVATE_KEY, ADMIN_ADDRESS (the Safe), ALLOCATOR_ADDRESS,
# GUARDIAN_ADDRESS, MANTLESCAN_API_KEY, optionally INITIAL_TIMELOCK_SECONDS.
cd contracts
forge script script/Deploy.s.sol --rpc-url $MANTLE_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify \
  --etherscan-api-key $MANTLESCAN_API_KEY -vvv
```

What the script does (and what it deliberately does NOT do):

1. Deploys `Guardrails`; one-shot `setConfig` bootstrap (sealed afterwards — every
   later change is timelocked).
2. Deploys `YieldVault` (ERC-4626, USDC), `AgentBenchmark` (+`setBenchmark`).
3. Deploys `AaveV3Adapter`, `UsdyAdapter` (with the mUSD leg), `AusdAdapter`, and
   **queues** each via `addStrategy` — they are NOT active yet.
4. Grants `ALLOCATOR` and `GUARDIAN`.
5. **Admin handoff (H4):** grants `DEFAULT_ADMIN_ROLE`+`ADMIN` on all three
   admin-bearing contracts to `ADMIN_ADDRESS`, then the deployer renounces its own.
   On mainnet the script reverts if `ADMIN_ADDRESS` is unset or equals the deployer.

### 3.3 Record the deployment

- Paste the printed JSON into `deployments/5000.json` (fill `deployedAt`).
- Update `packages/shared/src/deployments.ts` with the same addresses.
- Fill `VAULT_ADDRESS`, `GUARDRAILS_ADDRESS`, `BENCHMARK_ADDRESS`,
  `*_ADAPTER_ADDRESS`, and `VITE_VAULT_DEPLOY_BLOCK` (the deploy tx block) in `.env`.
- Verify every contract shows as verified on mantlescan.xyz; `--verify` occasionally
  misses one — use `forge verify-contract` for stragglers.

### 3.4 Activate the adapters (after the timelock)

`activateStrategy` is `ADMIN`-only, and ADMIN is now the **Safe** — the deployer key
can no longer do this. After `INITIAL_TIMELOCK_SECONDS` elapses, from the Safe
(Transaction Builder, or `cast` if one owner executes a pre-signed Safe tx), call on
the vault:

```text
activateStrategy(1)   # AAVE
activateStrategy(2)   # USDY (incl. mUSD leg)
activateStrategy(3)   # AUSD (escape hatch)
```

Confirm with `cast call $VAULT_ADDRESS "adapters(uint8)(address)" 1|2|3`.

### 3.5 Raise the timelock after the shakeout

Once smoke tests (§8) pass — typically within the first days — queue the raise from
the Safe on `Guardrails`:

```text
queueConfig(<current config with addStrategyTimelock = 172800>)
# wait the CURRENT (short) delay, then:
activateConfig()
```

The ratchet works in your favor: raising only waits the current short delay. A queued
config can be aborted with `cancelConfig()` if a value is wrong.

---

## 4. ERC-8004 identity

Register the agent in the canonical Identity Registry (the deployer or any key can own
the agent NFT — decide deliberately; prefer the admin Safe / a treasury key, NOT the
allocator: with `X402_PAY_TO` unset the x402 payee is derived from `ownerOf(AGENT_ID)`,
and a payee equal to the ALLOCATOR hot key is hard-rejected at agent startup):

```bash
# Build + pin the agent card (publishes the x402 `sells` offer when configured):
cd agent && pnpm card:pin            # needs AGENT_API_URL (+ wallet via ALLOCATOR_ADDRESS or key)
# set AGENT_CARD_URI to the printed ipfs:// URI, then:
cd contracts
forge script script/RegisterIdentity.s.sol --rpc-url $MANTLE_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
```

Copy the printed `AGENT_ID` into `.env` (`AGENT_ID`, `VITE_AGENT_ID`) and
`deployments/5000.json`.

---

## 5. Backend agent

### 5.1 Read-only first

Bring the agent up WITHOUT `ALLOCATOR_PRIVATE_KEY` to validate data plumbing safely:

```bash
pnpm install && pnpm -r build
node agent/dist/index.js   # or: docker compose up agent
```

- Startup asserts the RPC serves chainId 5000 (O6) — a wrong RPC fails fast.
- Check `GET /snapshot` returns live NAV/spot/Aave data and sane weights.
- Check `GET /agent-card`, and `/ask` if `ANTHROPIC_API_KEY` is set.

### 5.2 Arm execution

Add to `.env`: `ALLOCATOR_PRIVATE_KEY`, `VAULT_ADDRESS`, alert channels
(`TELEGRAM_*` / `DISCORD_WEBHOOK_URL` — do not skip these on mainnet), optionally
`TX_RECEIPT_TIMEOUT_MS` (default 120000 ms) and the x402 block
(`X402_ASSET` is the opt-in; `X402_PAY_TO` = owner/treasury or blank to derive from
`ownerOf(AGENT_ID)`, never the allocator — see `.env.example`). Restart. You should see
`autonomous scheduler started (periodic=60m, poll=30s)` in the logs.

Operational behavior to know:

- One cycle at a time (O3 mutex); receipt waits are bounded and a **required de-risk
  that fails to confirm fires a CRITICAL alert** (O1/O2) — page on that.
- State is in-memory (O4): after a crash/restart, check the vault's last txs on
  Mantlescan before assuming the agent's view is complete.
- The autonomous de-risk target is **USDC (idle)**; AUSD is a guardian-managed
  escape hatch (`emergencyExit` / manual rebalance).

### 5.3 Docker stack

```bash
docker compose build && docker compose up -d
docker compose logs -f agent
```

`docker-compose.yml` runs `agent` (port 8080 internal), `web` (static build), and
`caddy` (80/443). The agent reads `.env` via `env_file`.

---

## 6. Frontend

Set the `VITE_*` vars in `.env` (`VITE_DEFAULT_CHAIN=mantle`, `VITE_AGENT_API_URL`
to the public `/api` URL, `VITE_AGENT_ID`, `VITE_VAULT_DEPLOY_BLOCK`; leave
`VITE_DEMO_MODE` blank for live reads). Then:

```bash
pnpm -C web build    # outputs web/dist, served by Caddy
```

The app auto-resolves vault addresses from `@custos/shared` for the active chain —
which is why §3.3 (updating `deployments.ts`) must happen before this build.

---

## 7. Caddy / domain

`Caddyfile` proxies `/api/*` → agent:8080 and serves the SPA. For TLS, replace `:80`
with your domain (Caddy auto-provisions Let's Encrypt):

```caddyfile
custos.example.com {
    handle_path /api/* { reverse_proxy agent:8080 }
    handle { root * /srv; try_files {path} /index.html; file_server }
    encode gzip zstd
}
```

Note the agent's CORS default is `*` (read-only endpoints); set
`CORS_ALLOWED_ORIGINS=https://custos.example.com` in production.

---

## 8. Post-deploy smoke tests & monitoring

Run through, in order, with a small test wallet:

1. **Deposit** $50–100 USDC via the UI; confirm shares minted, dashboard updates.
2. **Withdraw** part of it; confirm instant serve from idle/Aave.
3. Wait for (or trigger) one **rebalance** cycle; verify the `DecisionRecorded` event
   on Mantlescan and that the decision feed shows rationale + evidence.
4. **Alert test:** temporarily set a bogus RPC in a staging copy (NOT prod) or
   drop the Anthropic key to confirm the failure paths log/alert as expected; at
   minimum send a manual Telegram/Discord message through the configured webhook.
5. **Guardian drill:** from the GUARDIAN key, `pause()` then `unpause()` once, so the
   first time you exercise the kill path is not during an incident.
6. **Benchmark:** confirm `AgentBenchmark` recorded the decision and the UI baseline
   counter moves.

**Ongoing monitoring (minimum):** alert channel for de-risk success/failure (built
in), watch `ConfigQueued`/`GuardrailsQueued`/`ConfigCancelled` events on Guardrails
and `RoleGranted`/`RoleRevoked` on the vault (Safe compromise tripwire), uptime check
on `/snapshot`, and a low-balance alert on the allocator's MNT.

---

## 9. Incident playbook (quick reference)

| Situation | Action | Who |
|---|---|---|
| Suspicious agent behavior | `pause()` — blocks deposits/rebalance; withdrawals stay open | GUARDIAN |
| Allocator key compromised | `pause()`, then revoke `ALLOCATOR` role via Safe, rotate key | GUARDIAN + Safe |
| RWA event the agent missed | `deRisk` happens via guardian path: `emergencyExit(bucket, minOut, swapData)` | GUARDIAN |
| Bad queued config | `cancelConfig()` on Guardrails | Safe |
| Worst case | `kill()` — permanent; users redeem, guardian unwinds positions | GUARDIAN |

---

## 10. Testnet (5003) differences

- Deploy mocks first if needed: `forge script script/DeployMocks.s.sol --rpc-url $MANTLE_TESTNET_RPC_URL --broadcast`, then set the `TESTNET_*` vars.
- `ADMIN_ADDRESS` is optional (deployer keeps admin) and the timelock bootstraps to
  the 1h floor automatically; run `ActivateStrategies.s.sol` ~1h after deploy:

```bash
forge script script/ActivateStrategies.s.sol --rpc-url $MANTLE_TESTNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
```

- Record addresses in `deployments/5003.json` + `packages/shared/src/deployments.ts`.
