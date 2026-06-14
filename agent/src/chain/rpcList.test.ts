import { describe, it, expect, vi } from "vitest";

import {
  FALLBACK_RPCS,
  fetchMantleRpcList,
  resolveRpcUrls,
  resolveMantleRpcUrls,
} from "./rpcList.js";

// Identity "shuffle" so ordering assertions are deterministic.
const noShuffle = <T>(items: readonly T[]): T[] => items.slice();

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("resolveRpcUrls", () => {
  it("pins the premium endpoint first", () => {
    const out = resolveRpcUrls({
      premium: "https://premium.example",
      fetched: ["https://a.example", "https://b.example"],
      shuffle: noShuffle,
    });
    expect(out[0]).toBe("https://premium.example");
    expect(out).toEqual(["https://premium.example", "https://a.example", "https://b.example"]);
  });

  it("dedupes across premium, fetched, and static (ignoring trailing slashes)", () => {
    const out = resolveRpcUrls({
      premium: "https://a.example",
      fetched: ["https://a.example/", "https://b.example"],
      staticUrls: ["https://b.example", "https://c.example"],
      shuffle: noShuffle,
    });
    expect(out).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
  });

  it("drops non-http(s) and malformed urls", () => {
    const out = resolveRpcUrls({
      fetched: ["wss://x.example", "not-a-url", "https://ok.example"],
      shuffle: noShuffle,
    });
    expect(out).toEqual(["https://ok.example"]);
  });

  it("works with no premium configured", () => {
    const out = resolveRpcUrls({ fetched: ["https://a.example"], shuffle: noShuffle });
    expect(out).toEqual(["https://a.example"]);
  });

  it("actually reorders the public pool via shuffle while keeping premium first", () => {
    const reverse = <T>(items: readonly T[]): T[] => items.slice().reverse();
    const out = resolveRpcUrls({
      premium: "https://premium.example",
      fetched: ["https://a.example", "https://b.example"],
      shuffle: reverse,
    });
    expect(out).toEqual(["https://premium.example", "https://b.example", "https://a.example"]);
  });
});

describe("fetchMantleRpcList", () => {
  it("parses rpcs[].url from a well-formed document", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ chainId: 5000, rpcs: [{ url: "https://a.example" }, { url: "https://b.example" }] }),
    ) as unknown as typeof fetch;
    await expect(fetchMantleRpcList({ fetchFn })).resolves.toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("filters out non-http and malformed urls", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ rpcs: [{ url: "wss://x.example" }, { url: "https://ok.example" }, { url: 42 }] }),
    ) as unknown as typeof fetch;
    await expect(fetchMantleRpcList({ fetchFn })).resolves.toEqual(["https://ok.example"]);
  });

  it("falls back to the pinned list on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false)) as unknown as typeof fetch;
    await expect(fetchMantleRpcList({ fetchFn })).resolves.toEqual([...FALLBACK_RPCS]);
  });

  it("falls back to the pinned list when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchMantleRpcList({ fetchFn })).resolves.toEqual([...FALLBACK_RPCS]);
  });

  it("falls back to the pinned list when the document has no usable urls", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ rpcs: [] })) as unknown as typeof fetch;
    await expect(fetchMantleRpcList({ fetchFn })).resolves.toEqual([...FALLBACK_RPCS]);
  });
});

describe("resolveMantleRpcUrls", () => {
  it("composes premium + live list + static, premium first", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ rpcs: [{ url: "https://live.example" }] }),
    ) as unknown as typeof fetch;
    const out = await resolveMantleRpcUrls(
      { premiumMantleRpc: "https://premium.example", mantleRpcUrl: "https://static.example" },
      { fetchFn },
    );
    expect(out[0]).toBe("https://premium.example");
    expect(out).toContain("https://live.example");
    expect(out).toContain("https://static.example");
  });

  it("still returns the static config when the fetch fails entirely", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const out = await resolveMantleRpcUrls({ mantleRpcUrl: "https://static.example" }, { fetchFn });
    expect(out).toContain("https://static.example");
  });
});
