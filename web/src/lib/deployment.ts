// Deployment resolution for the web app's on-chain reads.
//
// The app reads LIVE by default: addresses come from the committed
// @custos/shared deployment record for the active chain, so a deployed chain
// works with no manual env. Precedence:
//   1. VITE_DEMO_MODE=true        -> force the typed fixtures (demo/screenshots)
//   2. VITE_VAULT_ADDRESS=0x...   -> explicit override (vault only)
//   3. getDeployment(chainId)     -> committed addresses from @custos/shared
// When no vault is resolvable (e.g. mainnet before its deploy), callers fall
// back to fixtures so the UI still renders.

import { getDeployment } from "@custos/shared";
import type { WeightsBps } from "./data";

/** Force the typed fixtures regardless of deploy state (for the demo video / screenshots). */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

const ENV_VAULT = (import.meta.env.VITE_VAULT_ADDRESS ?? "").trim();

const isAddr = (a: string | undefined | null): a is `0x${string}` =>
  typeof a === "string" && a.length === 42 && a.startsWith("0x");

export interface ResolvedDeployment {
  vault: `0x${string}` | "";
  guardrails: `0x${string}` | "";
  benchmark: `0x${string}` | "";
  aaveAdapter: `0x${string}` | "";
  usdyAdapter: `0x${string}` | "";
  ausdAdapter: `0x${string}` | "";
}

const EMPTY: ResolvedDeployment = { vault: "", guardrails: "", benchmark: "", aaveAdapter: "", usdyAdapter: "", ausdAdapter: "" };

/** Resolve Custos contract addresses for a chain (see precedence above). */
export function resolveDeployment(chainId: number | undefined): ResolvedDeployment {
  if (DEMO_MODE || chainId === undefined) return EMPTY;
  const d = getDeployment(chainId);
  // Note: a VITE_VAULT_ADDRESS override is chain-agnostic — it's returned on any
  // connected chain. It's a dev convenience; keep your wallet on the chain the
  // override belongs to, or reads/writes will target a vault that isn't there.
  const vault = isAddr(ENV_VAULT) ? ENV_VAULT : isAddr(d.vault) ? d.vault : "";
  if (!vault) return EMPTY; // no vault for this chain -> fixtures
  return {
    vault,
    guardrails:  isAddr(d.guardrails)  ? d.guardrails  : "",
    benchmark:   isAddr(d.benchmark)   ? d.benchmark   : "",
    aaveAdapter: isAddr(d.aaveAdapter) ? d.aaveAdapter : "",
    usdyAdapter: isAddr(d.usdyAdapter) ? d.usdyAdapter : "",
    ausdAdapter: isAddr(d.ausdAdapter) ? d.ausdAdapter : "",
  };
}

/** True when on-chain reads should run for this chain (a vault is resolvable). */
export function isLiveChain(chainId: number | undefined): boolean {
  return resolveDeployment(chainId).vault.length > 2;
}

/**
 * Allocation weights (bps) from per-bucket USDC-denominated balances. These are
 * ratios, so token decimals cancel. An empty vault (total 0) yields all-zero
 * weights. Largest-remainder rounding keeps the four weights summing to exactly
 * 10_000 whenever total > 0.
 */
export function computeWeightsBps(b: { idle: bigint; aave: bigint; usdy: bigint; ausd: bigint }): WeightsBps {
  const total = b.idle + b.aave + b.usdy + b.ausd;
  if (total <= 0n) return { IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0 };

  const parts = ([["IDLE", b.idle], ["AAVE", b.aave], ["USDY", b.usdy], ["AUSD", b.ausd]] as [keyof WeightsBps, bigint][])
    .map(([k, v]) => {
      const scaled = (v < 0n ? 0n : v) * 10_000n;
      const bps = scaled / total;
      return { k, bps: Number(bps), rem: scaled - bps * total };
    });

  const leftover = 10_000 - parts.reduce((s, p) => s + p.bps, 0);
  // Hand the leftover bps to the largest fractional remainders first.
  parts.sort((a, c) => (c.rem > a.rem ? 1 : c.rem < a.rem ? -1 : 0));
  for (let i = 0; i < leftover; i++) {
    const p = parts[i % parts.length];
    if (p) p.bps += 1;
  }

  const out: WeightsBps = { IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0 };
  for (const p of parts) out[p.k] = p.bps;
  return out;
}
