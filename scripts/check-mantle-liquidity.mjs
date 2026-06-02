#!/usr/bin/env node
// scripts/check-mantle-liquidity.mjs
//
// Live liquidity + peg probe for Custos's RWA legs on Mantle (chainId 5000).
//
// Zero dependencies on purpose: runs with plain `node scripts/check-mantle-liquidity.mjs`
// (Node >= 22 for global fetch) — no pnpm install, no build step, no workspace
// wiring — so it works from a laptop or a GitHub Action with only setup-node.
//
// Why it exists: Claude's execution sandbox is network-allowlisted (every
// outbound host returns 403), so any *live* on-chain/API data has to be pulled
// from an environment that has egress. This also doubles as an early, throwaway
// prototype of Custos's "RWA liquidity thinning / depeg" risk signal.
//
// Sources (all read-only, no keys required):
//   - DeFiLlama yields  -> DEX pool TVL       https://yields.llama.fi/pools
//   - DeFiLlama coins   -> spot prices (peg)  https://coins.llama.fi/prices/current/...
//   - Mantle RPC        -> tokenized supply   eth_call totalSupply() (selector 0x18160ddd)
//
// Usage:
//   node scripts/check-mantle-liquidity.mjs                  # human-readable report
//   node scripts/check-mantle-liquidity.mjs --json           # machine-readable JSON to stdout
//   node scripts/check-mantle-liquidity.mjs --write          # also write reports/mantle-liquidity.{json,md}
//   node scripts/check-mantle-liquidity.mjs --min=250000     # exit 1 if RWA DEX liquidity < $250k
//
// Token addresses (USDC/USDY/AUSD/WMNT/mUSD) are read from
// packages/shared/src/tokens.ts — the single source of truth.
//
// Env:
//   MANTLE_RPC_URL  (default https://rpc.mantle.xyz)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Canonical Mantle addresses — sourced from packages/shared/src/tokens.ts ──
// Parsed at runtime (not imported) so this script stays dependency-free and
// runnable from a bare runner, while keeping tokens.ts the single source of
// truth — no inlined addresses to drift. $1-peg expectations are layered on
// locally (USDY accrues; WMNT floats).
const PEGS = { USDC: 1, AUSD: 1, MUSD: 1 };

function loadTokens() {
  const file = resolve(ROOT, "packages/shared/src/tokens.ts");
  const src = readFileSync(file, "utf8");
  const re =
    /(\w+):\s*\{\s*symbol:\s*"[^"]*",\s*name:\s*"[^"]*",\s*address:\s*"(0x[0-9a-fA-F]{40})",\s*decimals:\s*(\d+)/g;
  const out = {};
  for (let m; (m = re.exec(src)); ) {
    const [, key, address, decimals] = m;
    out[key] = { address, decimals: Number(decimals), peg: key in PEGS ? PEGS[key] : null };
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`no tokens parsed from ${file}`);
  }
  return out;
}

const TOKENS = loadTokens();

const RPC_URL = process.env.MANTLE_RPC_URL?.trim() || "https://rpc.mantle.xyz";
const CHAIN = "Mantle";
const SYMBOL_RE = /MUSD|USDY/i; // pool symbols that mention an RWA leg

// ── CLI flags ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const getOpt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const AS_JSON = hasFlag("json");
const DO_WRITE = hasFlag("write");
const MIN_LIQUIDITY = Number(getOpt("min", "0"));

// ── helpers ─────────────────────────────────────────────────────────────────
const usd = (n) =>
  n == null ? "n/a" : "$" + Math.round(n).toLocaleString("en-US");
const pct = (n) => (n == null ? "n/a" : `${n.toFixed(2)}%`);

// Redact the RPC endpoint to host-only so a private/keyed URL can never land in
// a committed report (CLAUDE.md non-negotiable #7: never commit secrets).
const rpcHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "[unparseable]";
  }
};

async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// eth_call totalSupply() -> bigint
async function totalSupply(address) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: address, data: "0x18160ddd" }, "latest"],
  };
  const out = await getJson(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (out.error) throw new Error(out.error.message ?? "eth_call failed");
  return BigInt(out.result);
}

const toUnits = (raw, decimals) => Number(raw) / 10 ** decimals;

// ── data sources (each isolated; one failing must not sink the others) ───────
async function fetchPools() {
  const { data } = await getJson("https://yields.llama.fi/pools");
  const usdy = TOKENS.USDY.address.toLowerCase();
  const musd = TOKENS.MUSD?.address.toLowerCase();
  return data
    .filter((p) => p.chain === CHAIN)
    .filter((p) => {
      if (SYMBOL_RE.test(p.symbol ?? "")) return true;
      const under = (p.underlyingTokens ?? []).map((t) => String(t).toLowerCase());
      return under.includes(usdy) || (musd && under.includes(musd));
    })
    .map((p) => ({
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd ?? 0,
      apy: p.apy ?? null,
      pool: p.pool,
      poolMeta: p.poolMeta ?? null,
    }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
}

async function fetchPrices() {
  const ids = Object.values(TOKENS)
    .map((t) => `mantle:${t.address}`)
    .join(",");
  const { coins } = await getJson(`https://coins.llama.fi/prices/current/${ids}`);
  const out = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    const c =
      coins[`mantle:${t.address}`] ?? coins[`mantle:${t.address.toLowerCase()}`];
    const price = c?.price ?? null;
    let status = "no price";
    if (price != null) {
      if (t.peg == null) status = "accruing / no peg";
      else status = Math.abs(price - t.peg) > 0.005 ? "OFF PEG" : "ok";
    }
    out[sym] = { price, peg: t.peg, status };
  }
  return out;
}

async function fetchSupplies(prices) {
  const targets = [["USDY", TOKENS.USDY]];
  if (TOKENS.MUSD) targets.push(["MUSD", TOKENS.MUSD]);
  const out = {};
  for (const [sym, t] of targets) {
    try {
      const supply = toUnits(await totalSupply(t.address), t.decimals);
      const price = prices?.[sym]?.price ?? null;
      out[sym] = { supply, usd: price != null ? supply * price : null };
    } catch (err) {
      out[sym] = { error: String(err?.message ?? err) };
    }
  }
  return out;
}

// ── report rendering ─────────────────────────────────────────────────────────
function buildReport({ pools, prices, supplies }) {
  const totalTvl = (pools ?? []).reduce((s, p) => s + p.tvlUsd, 0);
  return {
    generatedAt: new Date().toISOString(),
    chain: CHAIN,
    rpc: rpcHost(RPC_URL),
    musdIncluded: Boolean(TOKENS.MUSD),
    rwaDexLiquidityUsd: totalTvl,
    poolCount: (pools ?? []).length,
    pools,
    prices,
    supplies,
  };
}

function toMarkdown(r) {
  const lines = [];
  lines.push(`# Mantle RWA Liquidity & Peg — ${r.generatedAt}`);
  lines.push("");
  lines.push(`Generated by \`scripts/check-mantle-liquidity.mjs\`. Chain: ${r.chain}.`);
  lines.push(
    "> _Indicative monitoring only._ DeFiLlama pool TVL is not executable swap " +
      "depth; the authoritative gate is `testLiquidityGateUsdy` in " +
      "`contracts/test/Fork.t.sol`.",
  );
  lines.push(r.musdIncluded ? "" : "> mUSD not in tokens.ts — add it to packages/shared/src/tokens.ts for supply + price.");
  lines.push("");
  lines.push("## On-chain tokenized supply");
  lines.push("| Token | Supply | ≈ USD |");
  lines.push("|---|--:|--:|");
  for (const [sym, s] of Object.entries(r.supplies ?? {})) {
    if (s.error) lines.push(`| ${sym} | error: ${s.error} | — |`);
    else lines.push(`| ${sym} | ${Math.round(s.supply).toLocaleString("en-US")} | ${usd(s.usd)} |`);
  }
  lines.push("");
  lines.push("## DEX liquidity (DeFiLlama yields)");
  lines.push("| Project | Symbol | TVL | APY |");
  lines.push("|---|---|--:|--:|");
  for (const p of r.pools ?? []) {
    const meta = p.poolMeta ? ` (${p.poolMeta})` : "";
    lines.push(`| ${p.project} | ${p.symbol}${meta} | ${usd(p.tvlUsd)} | ${pct(p.apy)} |`);
  }
  lines.push(`| **Total** | **${r.poolCount} pools** | **${usd(r.rwaDexLiquidityUsd)}** | |`);
  lines.push("");
  lines.push("## Peg");
  lines.push("| Token | Price | Status |");
  lines.push("|---|--:|---|");
  for (const [sym, pr] of Object.entries(r.prices ?? {})) {
    lines.push(`| ${sym} | ${pr.price == null ? "n/a" : "$" + pr.price.toFixed(4)} | ${pr.status} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function printHuman(r) {
  const c = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", x: "\x1b[0m" };
  console.log(`${c.b}Custos — Mantle RWA liquidity & peg probe${c.x}  ${c.dim}${r.generatedAt}${c.x}`);
  console.log(`${c.dim}RPC: ${r.rpc}${c.x}`);
  if (!r.musdIncluded) console.log(`${c.y}note:${c.x} mUSD not in tokens.ts — add it to packages/shared/src/tokens.ts.`);
  console.log("");

  console.log(`${c.b}On-chain tokenized supply${c.x}`);
  for (const [sym, s] of Object.entries(r.supplies ?? {})) {
    if (s.error) console.log(`  ${sym.padEnd(5)} ${c.r}error: ${s.error}${c.x}`);
    else console.log(`  ${sym.padEnd(5)} ${Math.round(s.supply).toLocaleString("en-US").padStart(16)}  ≈ ${usd(s.usd)}`);
  }
  console.log("");

  console.log(`${c.b}DEX liquidity (DeFiLlama)${c.x}`);
  if (!r.pools?.length) {
    console.log(`  ${c.y}no matching pools returned${c.x}`);
  } else {
    for (const p of r.pools) {
      const meta = p.poolMeta ? ` ${c.dim}(${p.poolMeta})${c.x}` : "";
      console.log(`  ${p.project.padEnd(18)} ${String(p.symbol).padEnd(18)} ${usd(p.tvlUsd).padStart(13)}  ${c.dim}APY ${pct(p.apy)}${c.x}${meta}`);
    }
  }
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  ${c.b}TOTAL${c.x}  ${usd(r.rwaDexLiquidityUsd)} across ${r.poolCount} pools`);
  console.log("");

  console.log(`${c.b}Spot price / peg${c.x}`);
  for (const [sym, pr] of Object.entries(r.prices ?? {})) {
    const col = pr.status === "OFF PEG" ? c.r : pr.status === "ok" ? c.g : c.dim;
    console.log(`  ${sym.padEnd(5)} ${(pr.price == null ? "n/a" : "$" + pr.price.toFixed(4)).padStart(10)}  ${col}${pr.status}${c.x}`);
  }
  console.log("");

  const healthy = r.rwaDexLiquidityUsd >= MIN_LIQUIDITY;
  const verdict = MIN_LIQUIDITY > 0 ? (healthy ? `${c.g}HEALTHY${c.x} (>= ${usd(MIN_LIQUIDITY)})` : `${c.r}THIN${c.x} (< ${usd(MIN_LIQUIDITY)})`) : "(no --min threshold set)";
  console.log(`${c.b}VERDICT${c.x} USDY/mUSD DEX liquidity on Mantle = ${usd(r.rwaDexLiquidityUsd)} — ${verdict}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Run sources concurrently; tolerate partial failure.
  const [poolsR, pricesR] = await Promise.allSettled([fetchPools(), fetchPrices()]);
  const pools = poolsR.status === "fulfilled" ? poolsR.value : [];
  const prices = pricesR.status === "fulfilled" ? pricesR.value : {};
  if (poolsR.status === "rejected") console.error(`[pools] ${poolsR.reason}`);
  if (pricesR.status === "rejected") console.error(`[prices] ${pricesR.reason}`);

  const supplies = await fetchSupplies(prices).catch((e) => {
    console.error(`[supplies] ${e}`);
    return {};
  });

  const report = buildReport({ pools, prices, supplies });

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  if (DO_WRITE) {
    const dir = resolve(ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "mantle-liquidity.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(resolve(dir, "mantle-liquidity.md"), toMarkdown(report) + "\n");
    if (!AS_JSON) console.log(`\nwrote reports/mantle-liquidity.json and .md`);
  }

  // Non-zero exit for CI alerting when a threshold is set and not met.
  if (MIN_LIQUIDITY > 0 && report.rwaDexLiquidityUsd < MIN_LIQUIDITY) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
