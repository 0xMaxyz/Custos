# agent

Node.js + TypeScript + Fastify risk-guardian service for Custos.

## Run

```bash
pnpm -C agent dev     # dev server with hot reload
pnpm -C agent build   # compile TypeScript
pnpm -C agent test    # vitest unit + integration tests
```

## Environment

Copy `.env.example` from the repo root and fill in:

```bash
MANTLE_RPC_URL=          # required for on-chain reads
ANTHROPIC_API_KEY=       # required for LLM rationale
ALLOCATOR_PRIVATE_KEY=   # optional — enables autonomous rebalance/de-risk loop
VAULT_ADDRESS=           # optional — set to enable on-chain execution
ONEDELTA_API_KEY=        # optional — Aave/market data breadth
```

The agent runs **read-only** without `ALLOCATOR_PRIVATE_KEY`/`VAULT_ADDRESS` — useful
for monitoring, `/snapshot`, and `/ask` without any custody risk.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/snapshot` | Live market state + risk flags (polled by web Insights every 15s) |
| `POST` | `/ask` | Conversational Q&A — grounded in snapshot + recent decisions |
| `GET` | `/risk-score` | x402-gated RWA risk score (pays 402, returns score + receipt) |

## Source structure

```
src/
  index.ts              Entry — wires agent, scheduler, explainer, alerts
  server.ts             Fastify routes + x402 middleware
  ingestion/
    snapshot.ts         Snapshotter — collects market state from 1delta + RPC
    oneDelta.ts         1delta API client (Aave pools, yields, AUSD PoR)
    rpcReaders.ts       Direct Mantle RPC reads (USDY NAV/spot, Aave, AUSD)
  risk-engine/
    engine.ts           Deterministic risk math (peg/oracle/buffer/yield-spread)
  llm/
    client.ts           LLMClient interface (mockable)
    anthropic.ts        AnthropicClient — wraps @anthropic-ai/sdk
    explain.ts          AnthropicExplainer — grounded conversational Q&A
  executor/
    signer.ts           Builds + signs rebalance/deRisk transactions (viem)
    ipfs.ts             Pins rationale + evidence bundles to IPFS
    benchmark.ts        Writes outcome + passive-delta to AgentBenchmark
  guardrail-validator/
    validator.ts        TS mirror of on-chain Guardrails — validates before signing
  identity/
    agentCard.ts        Builds + pins the ERC-8004 agent card JSON
  payments/
    x402.ts             x402 client (EIP-3009 / EIP-712 pay-and-fetch)
    verifier.ts         Inbound payment verifier (EIP-712 signer recovery + on-chain settle)
  alerts.ts             Telegram / Discord de-risk notifications
```

## In-depth docs

- [docs/spec.md](../docs/spec.md) — LLM prompt schema, guardrail parameters
- [docs/architecture.md](../docs/architecture.md) — AI vs algorithm split, data sources
- [docs/agents.md](../docs/agents.md) — non-negotiable rules (data/execution boundary, guardrails)
