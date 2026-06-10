/**
 * O4 — tx-journal: write/clear/read roundtrip, corrupt-file tolerance, and
 * startup reconciliation (confirmed / pending→confirmed / unconfirmed-required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeJournal,
  clearJournal,
  readJournal,
  reconcileJournal,
  type TxJournalEntry,
} from "./txjournal.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "custos-journal-"));
  path = join(dir, "state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
function entry(over: Partial<TxJournalEntry> = {}): TxJournalEntry {
  return { txHash: HASH, kind: "derisk", deRiskRequired: true, sentAt: "2026-06-10T00:00:00.000Z", ...over };
}

describe("txjournal write/clear/read", () => {
  it("roundtrips a written entry", () => {
    writeJournal(path, entry());
    expect(existsSync(path)).toBe(true);
    expect(readJournal(path)).toEqual(entry());
  });

  it("clear removes the file; read then returns undefined", () => {
    writeJournal(path, entry());
    clearJournal(path);
    expect(existsSync(path)).toBe(false);
    expect(readJournal(path)).toBeUndefined();
  });

  it("is a no-op when path is undefined (write/clear/read)", () => {
    expect(() => writeJournal(undefined, entry())).not.toThrow();
    expect(() => clearJournal(undefined)).not.toThrow();
    expect(readJournal(undefined)).toBeUndefined();
  });

  it("read tolerates a missing file", () => {
    expect(readJournal(path)).toBeUndefined();
  });

  it("read tolerates a corrupt (non-JSON) file without throwing", () => {
    writeFileSync(path, "{ this is not json", "utf-8");
    expect(() => readJournal(path)).not.toThrow();
    expect(readJournal(path)).toBeUndefined();
  });

  it("read rejects a well-formed-JSON but wrong-shape entry", () => {
    writeFileSync(path, JSON.stringify({ txHash: "not-hex", kind: "nope" }), "utf-8");
    expect(readJournal(path)).toBeUndefined();
  });
});

describe("reconcileJournal (startup recovery)", () => {
  it("no journal entry → does nothing (no client calls, no alert)", async () => {
    const getTransactionReceipt = vi.fn();
    const waitForTransactionReceipt = vi.fn();
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(alertFailure).not.toHaveBeenCalled();
  });

  it("already confirmed → logs, clears, no wait, no alert", async () => {
    writeJournal(path, entry());
    const getTransactionReceipt = vi.fn(async () => ({ status: "success" }));
    const waitForTransactionReceipt = vi.fn();
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(getTransactionReceipt).toHaveBeenCalledOnce();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(alertFailure).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("pending then confirms → waits, clears, no alert", async () => {
    writeJournal(path, entry());
    // viem throws (not returns null) when the receipt isn't found yet.
    const getTransactionReceipt = vi.fn(async () => { throw new Error("not found"); });
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }));
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    expect(alertFailure).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("required de-risk never confirms (wait throws) → fires CRITICAL alert, clears", async () => {
    writeJournal(path, entry({ deRiskRequired: true }));
    const getTransactionReceipt = vi.fn(async () => null);
    const waitForTransactionReceipt = vi.fn(async () => { throw new Error("timed out"); });
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(alertFailure).toHaveBeenCalledOnce();
    expect((alertFailure.mock.calls[0] as unknown[])[1]).toMatch(/timed out/);
    expect(existsSync(path)).toBe(false);
  });

  it("non-required tx never confirms → NO alert (only logged), still clears", async () => {
    writeJournal(path, entry({ kind: "rebalance", deRiskRequired: false }));
    const getTransactionReceipt = vi.fn(async () => null);
    const waitForTransactionReceipt = vi.fn(async () => { throw new Error("timed out"); });
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(alertFailure).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("required de-risk confirms REVERTED at startup → fires alert", async () => {
    writeJournal(path, entry({ deRiskRequired: true }));
    const getTransactionReceipt = vi.fn(async () => null);
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "reverted" }));
    const alertFailure = vi.fn();
    await reconcileJournal(path, { getTransactionReceipt, waitForTransactionReceipt }, {
      timeoutMs: 1000, log: () => {}, alertFailure,
    });
    expect(alertFailure).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(false);
  });
});
