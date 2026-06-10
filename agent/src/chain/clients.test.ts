import { describe, it, expect, vi } from "vitest";
import type { PublicClient } from "viem";

import { assertChainId } from "./clients.js";

// ── O6: startup chain-id verification ──────────────────────────────────────────

describe("assertChainId", () => {
  function clientReturning(id: number): PublicClient {
    return { getChainId: vi.fn(async () => id) } as unknown as PublicClient;
  }

  it("resolves when the RPC serves Mantle mainnet (5000)", async () => {
    await expect(assertChainId(clientReturning(5000))).resolves.toBeUndefined();
  });

  it("throws when the RPC serves a different chain", async () => {
    await expect(assertChainId(clientReturning(1))).rejects.toThrow(/chain-id mismatch/i);
    await expect(assertChainId(clientReturning(5003))).rejects.toThrow(/5000/); // mentions expected id
  });
});
