/**
 * x402 sell-side payee resolution tests (identity binding, spec §2.7).
 * No network — the `ownerOf` reader is injected.
 */
import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveX402PayTo, type OwnerReader } from "./payee.js";
import { loadConfig } from "../config.js";

const ASSET = `0x${"a0".repeat(20)}`;
const PAY_TO = "0x4444444444444444444444444444444444444444";
const OWNER = "0x5555555555555555555555555555555555555555";

const ALLOCATOR_KEY = `0x${"ab".repeat(32)}` as const;
const ALLOCATOR = privateKeyToAccount(ALLOCATOR_KEY).address;

function configWith(extra: Record<string, string> = {}) {
  return loadConfig({ MANTLE_RPC_URL: "https://rpc.mantle.xyz", ...extra });
}

const ownerReader = (owner: string): OwnerReader =>
  vi.fn(async () => owner as `0x${string}`);

describe("resolveX402PayTo", () => {
  it("resolves none when X402_ASSET is unset (asset is the opt-in)", async () => {
    // Even with an AGENT_ID present, no asset means nothing is sold and the
    // reader must not be consulted — a registered agent never auto-enables selling.
    const readOwner = ownerReader(OWNER);
    const out = await resolveX402PayTo({ config: configWith({ AGENT_ID: "7" }), readOwner });
    expect(out).toEqual({ source: "none" });
    expect(readOwner).not.toHaveBeenCalled();
  });

  it("resolves none when neither X402_PAY_TO nor AGENT_ID is set", async () => {
    const out = await resolveX402PayTo({ config: configWith({ X402_ASSET: ASSET }) });
    expect(out).toEqual({ source: "none" });
  });

  it("uses the configured X402_PAY_TO (checksummed, source 'config')", async () => {
    const config = configWith({ X402_PAY_TO: PAY_TO.toLowerCase(), X402_ASSET: ASSET });
    const out = await resolveX402PayTo({ config });
    expect(out.source).toBe("config");
    expect(out.payTo).toBe(getAddress(PAY_TO));
  });

  it("derives the payee from ownerOf(agentId) when X402_PAY_TO is unset (source 'owner')", async () => {
    const readOwner = ownerReader(OWNER.toLowerCase());
    const config = configWith({ X402_ASSET: ASSET, AGENT_ID: "7" });
    const out = await resolveX402PayTo({ config, readOwner });
    expect(out.source).toBe("owner");
    expect(out.payTo).toBe(getAddress(OWNER));
    expect(readOwner).toHaveBeenCalledWith(7n);
  });

  it("warns (but keeps the configured payee) when X402_PAY_TO differs from the agent owner", async () => {
    const warn = vi.fn();
    const config = configWith({ X402_PAY_TO: PAY_TO, X402_ASSET: ASSET, AGENT_ID: "7" });
    const out = await resolveX402PayTo({ config, readOwner: ownerReader(OWNER), warn });
    expect(out).toEqual({ payTo: getAddress(PAY_TO), source: "config" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/differs from ownerOf/);
  });

  it("stays quiet when X402_PAY_TO matches the agent owner", async () => {
    const warn = vi.fn();
    const config = configWith({ X402_PAY_TO: OWNER, X402_ASSET: ASSET, AGENT_ID: "7" });
    await resolveX402PayTo({ config, readOwner: ownerReader(OWNER.toLowerCase()), warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a failed reconcile read as a warning, not a failure (configured payee stands)", async () => {
    const warn = vi.fn();
    const readOwner: OwnerReader = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const config = configWith({ X402_PAY_TO: PAY_TO, X402_ASSET: ASSET, AGENT_ID: "7" });
    const out = await resolveX402PayTo({ config, readOwner, warn });
    expect(out).toEqual({ payTo: getAddress(PAY_TO), source: "config" });
    expect(warn.mock.calls[0]![0]).toMatch(/could not reconcile/);
  });

  it("fails loudly when deriving from the owner and the read fails (no fallback payee)", async () => {
    const readOwner: OwnerReader = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const config = configWith({ X402_ASSET: ASSET, AGENT_ID: "7" });
    await expect(resolveX402PayTo({ config, readOwner })).rejects.toThrow(/rpc down/);
  });

  it("rejects a configured payee equal to the ALLOCATOR hot key", async () => {
    const config = configWith({
      X402_PAY_TO: ALLOCATOR.toLowerCase(),
      X402_ASSET: ASSET,
      ALLOCATOR_PRIVATE_KEY: ALLOCATOR_KEY,
    });
    await expect(resolveX402PayTo({ config })).rejects.toThrow(/ALLOCATOR hot key/);
  });

  it("rejects an owner-derived payee equal to the ALLOCATOR hot key", async () => {
    const config = configWith({
      X402_ASSET: ASSET,
      AGENT_ID: "7",
      ALLOCATOR_PRIVATE_KEY: ALLOCATOR_KEY,
    });
    await expect(
      resolveX402PayTo({ config, readOwner: ownerReader(ALLOCATOR) }),
    ).rejects.toThrow(/ALLOCATOR hot key/);
  });

  it("rejects the ALLOCATOR via plain ALLOCATOR_ADDRESS too (keyless card pinning)", async () => {
    const config = configWith({
      X402_PAY_TO: ALLOCATOR.toLowerCase(),
      X402_ASSET: ASSET,
      ALLOCATOR_ADDRESS: ALLOCATOR.toLowerCase(),
    });
    await expect(resolveX402PayTo({ config })).rejects.toThrow(/ALLOCATOR hot key/);
  });

  it("skips the ALLOCATOR guard only when neither key nor address is configured", async () => {
    // Without either we cannot know the allocator address; the running agent
    // (which always has the key in execution mode) still enforces the guard.
    const config = configWith({ X402_PAY_TO: ALLOCATOR, X402_ASSET: ASSET });
    const out = await resolveX402PayTo({ config });
    expect(out.payTo).toBe(ALLOCATOR);
  });
});
