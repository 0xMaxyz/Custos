import { describe, it, expect, vi } from "vitest";

import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  it("returns a stored value before expiry", () => {
    let t = 1_000;
    const cache = new TtlCache({ defaultTtlMs: 100, now: () => t });
    cache.set("k", 42);
    t = 1_050;
    expect(cache.get<number>("k")).toBe(42);
  });

  it("expires a value after its ttl", () => {
    let t = 1_000;
    const cache = new TtlCache({ defaultTtlMs: 100, now: () => t });
    cache.set("k", 42);
    t = 1_101;
    expect(cache.get<number>("k")).toBeUndefined();
  });

  it("honors a per-entry ttl over the default", () => {
    let t = 0;
    const cache = new TtlCache({ defaultTtlMs: 1_000, now: () => t });
    cache.set("k", "v", 10);
    t = 11;
    expect(cache.get("k")).toBeUndefined();
  });

  it("getOrSet computes once then serves from cache", async () => {
    const cache = new TtlCache({ defaultTtlMs: 1_000, now: () => 0 });
    const fn = vi.fn(async () => "computed");
    expect(await cache.getOrSet("k", fn)).toBe("computed");
    expect(await cache.getOrSet("k", fn)).toBe("computed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("getOrSet de-dupes concurrent misses into one upstream call", async () => {
    const cache = new TtlCache({ defaultTtlMs: 1_000, now: () => 0 });
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return 7;
    };
    const [a, b] = await Promise.all([cache.getOrSet("k", fn), cache.getOrSet("k", fn)]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(calls).toBe(1);
  });

  it("does not cache a rejected computation", async () => {
    const cache = new TtlCache({ defaultTtlMs: 1_000, now: () => 0 });
    await expect(
      cache.getOrSet("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent call should retry rather than serve a poisoned entry.
    expect(await cache.getOrSet("k", async () => "ok")).toBe("ok");
  });

  it("clear and delete drop entries", () => {
    const cache = new TtlCache({ defaultTtlMs: 1_000, now: () => 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});
