// Server-side decision feed (Activity perf).
//
// The web Activity page used to backfill the whole DecisionRecorded/Rebalanced/DeRisked
// history via getLogs on EVERY page load — dozens of serial, range-limited calls against
// a rate-limited RPC, which is slow. This module does that scan ONCE on the agent (with
// its own RPC), builds the same feed the web used to build client-side, and caches it
// (in memory + a small JSON file) with a tracked last-synced block. The web then fetches
// the cached feed from `GET /decisions` instead of scanning the chain itself. A forced
// resync (`?refresh=1` / `POST /decisions/resync`) rebuilds from chain on demand.
//
// Scope: PERF only. The feed carries the same thin per-decision data the web built before
// (confidence 0 / empty signals+evidence / zeroed outcome) — the detail modal still
// fetches the pinned bundle client-side for the real confidence + rationale. Keeping the
// build thin means no N-bundle fetch on the server's hot path.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PublicClient } from "viem";

// ── Weights ──────────────────────────────────────────────────────────────────

export interface Weights {
  IDLE: number;
  AAVE: number;
  USDY: number;
  AUSD: number;
}

const IDLE_ONLY: Weights = { IDLE: 10_000, AAVE: 0, USDY: 0, AUSD: 0 };
const toW = (a: readonly number[]): Weights => ({ IDLE: a[0] ?? 0, AAVE: a[1] ?? 0, USDY: a[2] ?? 0, AUSD: a[3] ?? 0 });

// ── Output shape (matches the web Decision fields the UI renders) ─────────────

export interface FeedDecision {
  id: number;
  kind: 0 | 1;
  timestamp: string;
  riskLevel: "NORMAL" | "CAUTION" | "DERISK";
  confidence: number;
  toBucket?: number;
  preWeightsBps: Weights;
  postWeightsBps: Weights;
  flags: string[];
  maxUsdyWeightBpsAllowed: number;
  summary: string;
  rationale: string;
  signals: never[];
  evidence: never[];
  rationaleHash: string;
  decisionURI: string;
  outcome: { realizedYieldBps: number; passiveDeltaBps: number; drawdownAvoidedUsdc: string; measuredAt: string };
  txHash: string;
  isManual: boolean;
}

export interface DecisionFeed {
  decisions: FeedDecision[];
  /** Chain head the feed was synced to. */
  lastSyncedBlock: number;
  /** ISO timestamp the feed was built. */
  builtAt: string;
  isLive: true;
}

// ── Event ABIs (signatures verified against contracts/src/YieldVault.sol) ─────

const DECISION_RECORDED_EVENT = {
  type: "event", name: "DecisionRecorded",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "kind", type: "uint8", indexed: false },
    { name: "rationaleHash", type: "bytes32", indexed: false },
    { name: "decisionURI", type: "string", indexed: false },
  ],
} as const;
const REBALANCED_EVENT = {
  type: "event", name: "Rebalanced",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "postWeightsBps", type: "uint16[4]", indexed: false },
  ],
} as const;
const DERISKED_EVENT = {
  type: "event", name: "DeRisked",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "toBucket", type: "uint8", indexed: false },
    { name: "evidenceHash", type: "bytes32", indexed: false },
  ],
} as const;

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** A short "30% Idle / 70% Aave" description of the largest target buckets. */
export function describeWeights(w: Weights): string {
  const parts = ([["Idle", w.IDLE], ["Aave", w.AAVE], ["USDY", w.USDY], ["AUSD", w.AUSD]] as [string, number][])
    .filter(([, b]) => b > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `${Math.round(b / 100)}% ${k}`);
  return parts.join(" / ") || "—";
}

/** Best-effort post-weights for a de-risk (USDY → 0 into the destination bucket). */
export function deriveDeRiskPost(pre: Weights, toBucket: number | undefined): Weights {
  const moved = pre.USDY;
  if (moved === 0) return pre;
  return toBucket === 3
    ? { ...pre, USDY: 0, AUSD: pre.AUSD + moved }
    : { ...pre, USDY: 0, IDLE: pre.IDLE + moved };
}

interface RawLog {
  id: number;
  kind: number;
  rationaleHash: string;
  decisionURI: string;
  txHash: string;
  blockNumber: bigint | null;
}

/**
 * Join the three event streams into the ordered decision feed. Pure over already-fetched
 * logs + a block→timestamp map, so the chain-shaped join is unit-testable without RPC.
 * Mirrors the web's former buildLiveDecision exactly (thin per-decision data).
 */
export function buildDecisions(
  decoded: RawLog[],
  postById: Map<number, Weights>,
  toBucketById: Map<number, number>,
  tsByBlock: Map<bigint, number>,
): FeedDecision[] {
  const ascending = [...decoded].sort((a, b) => a.id - b.id);
  let prev: Weights = IDLE_ONLY;
  const built: FeedDecision[] = [];
  for (const d of ascending) {
    const toBucket = toBucketById.get(d.id);
    const post = d.kind === 1 ? deriveDeRiskPost(prev, toBucket) : postById.get(d.id) ?? prev;
    const ts = d.blockNumber != null ? tsByBlock.get(d.blockNumber) : undefined;
    const isManual = d.decisionURI.startsWith("manual:");
    const kindLabel = d.kind === 1 ? "de-risk" : "rebalance";
    built.push({
      id: d.id,
      kind: d.kind === 1 ? 1 : 0,
      timestamp: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
      riskLevel: d.kind === 1 ? "DERISK" : "NORMAL",
      confidence: 0,
      ...(toBucket !== undefined ? { toBucket } : {}),
      preWeightsBps: prev,
      postWeightsBps: post,
      flags: [],
      maxUsdyWeightBpsAllowed: 6000,
      summary: `${isManual ? "Manual" : "Agent"} ${kindLabel} → ${describeWeights(post)}`,
      rationale: isManual
        ? "Manual ALLOCATOR action, submitted on-chain within the guardrails. No model rationale — this was an operator decision."
        : "Recorded on-chain; the full model rationale lives in the decision bundle.",
      signals: [],
      evidence: [],
      rationaleHash: d.rationaleHash,
      decisionURI: d.decisionURI,
      outcome: { realizedYieldBps: 0, passiveDeltaBps: 0, drawdownAvoidedUsdc: "0", measuredAt: "" },
      txHash: d.txHash,
      isManual,
    });
    prev = post;
  }
  built.reverse(); // most-recent first
  return built;
}

// ── Chain build (I/O) ──────────────────────────────────────────────────────────

const MAX_LOG_RANGE = 10_000n;

async function getLogsPaged(
  client: PublicClient,
  address: `0x${string}`,
  event: typeof DECISION_RECORDED_EVENT | typeof REBALANCED_EVENT | typeof DERISKED_EVENT,
  fromBlock: bigint,
  head: bigint,
): Promise<{ args: Record<string, unknown>; blockNumber: bigint | null; transactionHash: string | null }[]> {
  const out: { args: Record<string, unknown>; blockNumber: bigint | null; transactionHash: string | null }[] = [];
  for (let start = fromBlock; start <= head; start += MAX_LOG_RANGE) {
    const end = start + MAX_LOG_RANGE - 1n < head ? start + MAX_LOG_RANGE - 1n : head;
    const logs = await client.getLogs({ address, event, fromBlock: start, toBlock: end });
    for (const l of logs) out.push({ args: l.args as Record<string, unknown>, blockNumber: l.blockNumber, transactionHash: l.transactionHash });
  }
  return out;
}

export interface BuildDeps {
  publicClient: PublicClient;
  vault: `0x${string}`;
  deployBlock: bigint;
}

/** Scan the chain from the vault deploy block and build the full decision feed. */
export async function buildDecisionFeed(deps: BuildDeps): Promise<DecisionFeed> {
  const { publicClient: client, vault, deployBlock } = deps;
  const head = await client.getBlockNumber();

  const [decLogs, rebLogs, derLogs] = await Promise.all([
    getLogsPaged(client, vault, DECISION_RECORDED_EVENT, deployBlock, head),
    getLogsPaged(client, vault, REBALANCED_EVENT, deployBlock, head),
    getLogsPaged(client, vault, DERISKED_EVENT, deployBlock, head),
  ]);

  const postById = new Map<number, Weights>();
  for (const l of rebLogs) postById.set(Number(l.args.id), toW(l.args.postWeightsBps as readonly number[]));
  const toBucketById = new Map<number, number>();
  for (const l of derLogs) toBucketById.set(Number(l.args.id), Number(l.args.toBucket));

  const blocks = [...new Set(decLogs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(
    blocks.map((b) => client.getBlock({ blockNumber: b }).then((blk) => tsByBlock.set(b, Number(blk.timestamp))).catch(() => {})),
  );

  const decoded: RawLog[] = decLogs.map((l) => ({
    id: Number(l.args.id),
    kind: Number(l.args.kind),
    rationaleHash: String(l.args.rationaleHash ?? ""),
    decisionURI: String(l.args.decisionURI ?? ""),
    txHash: l.transactionHash ?? "",
    blockNumber: l.blockNumber,
  }));

  return {
    decisions: buildDecisions(decoded, postById, toBucketById, tsByBlock),
    lastSyncedBlock: Number(head),
    builtAt: new Date().toISOString(),
    isLive: true,
  };
}

// ── Cache (in-memory + JSON file), TTL + forced refresh ─────────────────────────

export interface DecisionFeedCacheOptions {
  build: () => Promise<DecisionFeed>;
  /** Serve cache without rebuilding for this long (ms). Default 60s. */
  ttlMs?: number | undefined;
  /** Path to persist the feed across restarts (optional). */
  persistPath?: string | undefined;
  now?: (() => number) | undefined;
}

/**
 * Caches the built feed in memory (and optionally a JSON file). `get(refresh)` returns
 * the cache if it's fresh; otherwise (cold, stale, or forced) it rebuilds from chain.
 * Concurrent callers during a rebuild share the one in-flight promise. A failed rebuild
 * falls back to the last good cache (so a transient RPC error never blanks the feed).
 */
export class DecisionFeedCache {
  private readonly build: () => Promise<DecisionFeed>;
  private readonly ttlMs: number;
  private readonly persistPath: string | undefined;
  private readonly now: () => number;
  private cache: DecisionFeed | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<DecisionFeed> | null = null;

  constructor(opts: DecisionFeedCacheOptions) {
    this.build = opts.build;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.persistPath = opts.persistPath;
    this.now = opts.now ?? Date.now;
  }

  /** Load any persisted feed so the first request is instant after a restart. */
  async hydrate(): Promise<void> {
    if (!this.persistPath || this.cache) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as DecisionFeed;
      if (Array.isArray(parsed.decisions)) {
        this.cache = parsed;
        this.fetchedAt = this.now(); // treat the persisted feed as fresh until TTL elapses
      }
    } catch {
      /* no/invalid persisted feed — first get() will build */
    }
  }

  async get(refresh = false): Promise<DecisionFeed> {
    const fresh = this.cache !== null && this.now() - this.fetchedAt < this.ttlMs;
    if (!refresh && fresh) return this.cache!;
    if (this.inFlight) return this.inFlight; // coalesce concurrent rebuilds

    this.inFlight = this.build()
      .then(async (feed) => {
        this.cache = feed;
        this.fetchedAt = this.now();
        await this.persist(feed);
        return feed;
      })
      .catch((err: unknown) => {
        if (this.cache) return this.cache; // serve stale on a failed rebuild
        throw err;
      })
      .finally(() => { this.inFlight = null; });

    return this.inFlight;
  }

  private async persist(feed: DecisionFeed): Promise<void> {
    if (!this.persistPath) return;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(feed), "utf8");
    } catch {
      /* persistence is best-effort — the in-memory cache still serves */
    }
  }
}
