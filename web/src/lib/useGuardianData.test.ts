import { describe, it, expect, vi } from "vitest";
import { useDecisions, useDecision, useIdentity, getLogsPaged } from "./useGuardianData";
import { decisions } from "./data";

// These hooks are pure fixture seams (no React state) until contracts deploy, so
// they can be called directly in a unit test.

describe("useDecisions", () => {
  it("returns the fixture feed flagged not-live", () => {
    const r = useDecisions();
    expect(r.isLive).toBe(false);
    expect(r.decisions).toBe(decisions);
    expect(r.decisions.length).toBeGreaterThan(0);
  });
});

describe("useDecision", () => {
  it("looks up a decision by id", () => {
    const d = useDecision(14);
    expect(d?.id).toBe(14);
    expect(d?.kind).toBe(1); // de-risk
  });

  it("returns undefined for an unknown id", () => {
    expect(useDecision(9999)).toBeUndefined();
  });
});

describe("useIdentity", () => {
  it("returns identity + a derived baseline summary, not-live", () => {
    const r = useIdentity();
    expect(r.isLive).toBe(false);
    expect(r.identity.agentId).toBe(7);
    // Derived from the canonical baseline fixture (custos 45 − passive -3 = 48).
    expect(r.baseline.deltaBps).toBe(48);
    expect(r.baseline.custosAhead).toBe(true);
  });
});

describe("getLogsPaged (N5)", () => {
  it("splits [fromBlock, head] into maxRange pages and concatenates in order", async () => {
    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const getLogsRange = vi.fn(async (r: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push(r);
      return [`log@${r.fromBlock}`];
    });
    const out = await getLogsPaged(async () => 25_000n, getLogsRange, 0n, 10_000n);
    expect(ranges).toEqual([
      { fromBlock: 0n, toBlock: 9_999n },
      { fromBlock: 10_000n, toBlock: 19_999n },
      { fromBlock: 20_000n, toBlock: 25_000n },
    ]);
    expect(out).toEqual(["log@0", "log@10000", "log@20000"]);
  });

  it("uses a single bounded query when the span fits within maxRange", async () => {
    const getLogsRange = vi.fn(async () => ["only"]);
    const out = await getLogsPaged(async () => 500n, getLogsRange, 0n, 10_000n);
    expect(getLogsRange).toHaveBeenCalledTimes(1);
    expect(getLogsRange).toHaveBeenCalledWith({ fromBlock: 0n, toBlock: 500n });
    expect(out).toEqual(["only"]);
  });

  it("queries nothing when the deploy block is ahead of head", async () => {
    const getLogsRange = vi.fn(async () => ["x"]);
    const out = await getLogsPaged(async () => 100n, getLogsRange, 200n, 10_000n);
    expect(getLogsRange).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});
