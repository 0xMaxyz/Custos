# Docs

**Custos** — AI risk-guardian real-yield account on Mantle. Deposit USDC; the agent earns tokenized-Treasury (USDY) yield and autonomously de-risks on-chain when RWA danger appears — recording every decision and its evidence under a verifiable ERC-8004 identity.

## What to read

| Doc | What it covers |
|-----|----------------|
| [architecture.md](./architecture.md) | Product design, assets & allocation, AI vs algorithm split, scope |
| [spec.md](./spec.md) | Guardrail parameters, contract interfaces, LLM prompt schema |
| [ui.md](./ui.md) | UI/UX design spec, component inventory, data dictionary, fixtures |
| [agents.md](./agents.md) | Operating guide for AI coding agents and human contributors |
| [deploy.md](./deploy.md) | End-to-end deployment runbook (contracts, agent, web, ops) |
| [demo.md](./demo.md) | Demo video production guide _(launch artifact)_ |
| [marketing.md](./marketing.md) | Marketing copy, tweet thread, screenshot guide _(launch artifact)_ |

## Quick orientation

- **Understand the system** → [architecture.md](./architecture.md)
- **Build or audit contracts** → [spec.md](./spec.md) §1–2 + [contracts/README.md](../contracts/README.md)
- **Work on the AI agent** → [spec.md](./spec.md) §3 + [agent/README.md](../agent/README.md)
- **Build the frontend** → [ui.md](./ui.md) + [web/README.md](../web/README.md)
- **Deploy to mainnet/testnet** → [deploy.md](./deploy.md)
- **Contributor or coding-agent rules** → [agents.md](./agents.md)

## Package docs

Each package has setup/run instructions and links to the relevant in-depth docs here:

- [contracts/README.md](../contracts/README.md) — Solidity contracts (Foundry)
- [agent/README.md](../agent/README.md) — Node/TS risk-guardian service (Fastify)
- [web/README.md](../web/README.md) — React frontend (Vite)
- [packages/shared/README.md](../packages/shared/README.md) — Shared types, addresses, constants
