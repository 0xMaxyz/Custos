import { describe, it, expect, vi } from "vitest";
import {
  describeWeights,
  deriveDeRiskPost,
  buildDecisions,
  DecisionFeedCache,
  type DecisionFeed,
  type Weights,
} from "./decisionFeed.js";

const w = (IDLE: number, AAVE: number, USDY: number, AUSD: number): Weights => ({ IDLE, AAVE, USDY, AUSD });

describe("describeWeights", () => {
  it("lists non-zero buckets, largest first", () => {
    expect(describeWeights(w(3_000, 7_000, 0, 0))).toBe("70% Aave / 30% Idle");
  });
  it("renders an em dash for all-zero", () => {
    expect(describeWeights(w(0, 0, 0, 0))).toBe("—");
  });
});

describe("deriveDeRiskPost", () => {
  it("moves USDY into IDLE by default", () => {
    expect(deriveDeRiskPost(w(2_000, 1_000, 7_000, 0), 0)).toEqual(w(9_000, 1_000, 0, 0));
  });
  it("moves USDY into AUSD when toBucket is 3", () => {
    expect(deriveDeRiskPost(w(2_000, 1_000, 7_000, 0), 3)).toEqual(w(2_000, 1_000, 0, 7_000));
  });
  it("is a no-op when there is no USDY", () => {
    expect(deriveDeRiskPost(w(10_000, 0, 0, 0), 0)).toEqual(w(10_000, 0, 0, 0));
  });
});

describe("buildDecisions", () => {
  it("chains pre→post weights, detects manual, and orders most-recent first", () => {
    const decoded = [
      { id: 1, kind: 0, rationaleHash: "0xaa", decisionURI: "manual:web-allocator-rebalance", txHash: "0xt1", blockNumber: 100n },
      { id: 2, kind: 1, rationaleHash: "0xbb", decisionURI: "ipfs://bundle2", txHash: "0xt2", blockNumber: 200n },
    ];
    const postById = new Map<number, Weights>([[1, w(5_000, 0, 5_000, 0)]]);
    const toBucketById = new Map<number, number>([[2, 0]]); // de-risk into IDLE
    const tsByBlock = new Map<bigint, number>([[100n, 1_000], [200n, 2_000]]);

    const out = buildDecisions(decoded, postById, toBucketById, tsByBlock);

    expect(out.map((d) => d.id)).toEqual([2, 1]); // reversed (recent first)
    const d1 = out.find((d) => d.id === 1)!;
    const d2 = out.find((d) => d.id === 2)!;

    // #1: manual rebalance from all-idle → 50/50 idle/USDY.
    expect(d1.isManual).toBe(true);
    expect(d1.preWeightsBps).toEqual(w(10_000, 0, 0, 0));
    expect(d1.postWeightsBps).toEqual(w(5_000, 0, 5_000, 0));
    expect(d1.kind).toBe(0);

    // #2: de-risk chains from #1's post; USDY (5000) → IDLE.
    expect(d2.kind).toBe(1);
    expect(d2.preWeightsBps).toEqual(w(5_000, 0, 5_000, 0));
    expect(d2.postWeightsBps).toEqual(w(10_000, 0, 0, 0));
    expect(d2.riskLevel).toBe("DERISK");
    expect(d2.isManual).toBe(false);
    expect(d2.timestamp).toBe(new Date(2_000 * 1000).toISOString());
  });
});

describe("DecisionFeedCache", () => {
  const feed = (block: number): DecisionFeed => ({ decisions: [], lastSyncedBlock: block, builtAt: "x", isLive: true });

  it("builds on a cold get, then serves cache within the TTL", async () => {
    const build = vi.fn().mockResolvedValue(feed(1));
    const cache = new DecisionFeedCache({ build, ttlMs: 1_000, now: () => 0 });
    await cache.get();
    await cache.get();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when forced via refresh", async () => {
    const build = vi.fn().mockResolvedValue(feed(1));
    const cache = new DecisionFeedCache({ build, ttlMs: 1_000, now: () => 0 });
    await cache.get();
    await cache.get(true);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("rebuilds once the TTL has elapsed", async () => {
    let t = 0;
    const build = vi.fn().mockResolvedValue(feed(1));
    const cache = new DecisionFeedCache({ build, ttlMs: 1_000, now: () => t });
    await cache.get();
    t = 1_500;
    await cache.get();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("serves the last good feed when a rebuild fails", async () => {
    let t = 0;
    const build = vi.fn().mockResolvedValueOnce(feed(7)).mockRejectedValueOnce(new Error("rpc down"));
    const cache = new DecisionFeedCache({ build, ttlMs: 1_000, now: () => t });
    await cache.get();
    t = 2_000;
    const stale = await cache.get();
    expect(stale.lastSyncedBlock).toBe(7);
  });

  it("throws when the very first build fails (no cache to fall back to)", async () => {
    const cache = new DecisionFeedCache({ build: vi.fn().mockRejectedValue(new Error("rpc down")), now: () => 0 });
    await expect(cache.get()).rejects.toThrow(/rpc down/);
  });

  it("coalesces concurrent rebuilds into one build call", async () => {
    const build = vi.fn().mockImplementation(() => new Promise<DecisionFeed>((r) => setTimeout(() => r(feed(1)), 10)));
    const cache = new DecisionFeedCache({ build, ttlMs: 1_000, now: () => 0 });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
