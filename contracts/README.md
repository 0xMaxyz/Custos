# contracts

Solidity contracts for Custos — built with Foundry.

## Build & test

```bash
forge build --root contracts                                                    # compile
forge build --root contracts --offline                                          # offline (pre-installed solc)
forge test --root contracts --no-match-contract Fork                            # offline unit tests
forge test --root contracts --match-contract Fork --fork-url $MANTLE_RPC_URL   # fork tests (needs Mantle RPC)
```

> **solc binary in restricted environments:** if `forge build` can't reach
> `binaries.soliditylang.org`, install it from GitHub releases:
> ```bash
> mkdir -p ~/.svm/0.8.35
> curl -sSL -o ~/.svm/0.8.35/solc-0.8.35 \
>   https://github.com/ethereum/solidity/releases/download/v0.8.35/solc-static-linux
> chmod +x ~/.svm/0.8.35/solc-0.8.35
> forge build --root contracts --offline
> ```

## Structure

```
src/
  YieldVault.sol              ERC-4626 vault (asset = USDC); rebalance/deRisk
  Guardrails.sol              Immutable on-chain allocation limits + depeg guard
  AgentBenchmark.sol          Decision + passive-USDY baseline ledger
  AaveV3Adapter.sol           Aave v3 USDC supply/withdraw
  UsdyAdapter.sol             USDC↔USDY/mUSD via pinned 1delta swap executor
  AusdAdapter.sol             USDC↔AUSD via pinned 1delta swap executor
  CustosJobEscrow.sol         ERC-8183 job escrow (outside custody path)
  CustosDeRiskEvaluator.sol   Guardrail-gated evaluator for ERC-8183 jobs
  CustosIdentityRegistry.sol  ERC-8004 fallback identity registry
  CustosReputationRegistry.sol ERC-8004 fallback reputation registry
  Roles.sol                   ADMIN / ALLOCATOR / GUARDIAN role constants
  AggregatorSwapLib.sol       Balance-delta minOut helper for 1delta swap calldata
  Custos.sol                  Compile-time MANTLE_CHAIN_ID constant / scaffold marker
  interfaces/                 Canonical ABIs (ERC-8004, ERC-8183, IMusd, IStrategyAdapter…)

script/
  Deploy.s.sol                Main deploy (Guardrails → YieldVault → AgentBenchmark → adapters)
  DeployMocks.s.sol           Testnet mock USDC/USDY tokens
  RegisterIdentity.s.sol      ERC-8004 agent registration
  ActivateStrategies.s.sol    Strategy activation after add-strategy timelock

test/
  Phase*.t.sol                Offline unit tests (no RPC)
  ForkPhase*.t.sol            Fork tests — skipped in CI; require MANTLE_RPC_URL
```

## Deployed addresses

Mainnet (5000) contracts are deployed — see [`deployments/5000.json`](../deployments/5000.json).
The canonical address records live in [`packages/shared/src/deployments.ts`](../packages/shared/src/deployments.ts).
The root [`README.md`](../README.md) has full tables with MantleScan links.

## In-depth docs

- [docs/spec.md](../docs/spec.md) — guardrail parameters, contract interfaces
- [docs/architecture.md](../docs/architecture.md) — system design & allocation logic
- [docs/agents.md](../docs/agents.md) — coding conventions + non-negotiable rules
