import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

/**
 * O4 — crash-recovery tx journal.
 *
 * A single tiny JSON file recording the LAST submitted vault tx. The executor
 * writes it the instant `writeContract` returns a hash — BEFORE awaiting the
 * receipt — and clears it once the receipt confirms. If the process crashes
 * while a tx is in flight, the entry survives so startup can reconcile it (look
 * up the receipt; alert if a REQUIRED de-risk is still unconfirmed) instead of
 * silently forgetting a broadcast tx.
 *
 * Journaling is opt-in: when no path is configured every call is a no-op. All fs
 * ops are synchronous (one small file, written at most once per cycle) and the
 * read tolerates a missing/corrupt file by returning `undefined` rather than
 * throwing — a crash mid-write must never wedge startup.
 */

export interface TxJournalEntry {
  /** Broadcast tx hash. */
  readonly txHash: `0x${string}`;
  /** Which vault write was submitted. */
  readonly kind: "derisk" | "rebalance";
  /** True when this was a REQUIRED de-risk (forced or LLM verdict). */
  readonly deRiskRequired: boolean;
  /** ISO timestamp the tx was broadcast. */
  readonly sentAt: string;
}

/** Persist the in-flight tx. No-op when `path` is undefined. */
export function writeJournal(path: string | undefined, entry: TxJournalEntry): void {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(entry), "utf-8");
  } catch {
    // Never let a journal write failure abort the cycle — the tx is already
    // broadcast; losing the crash-recovery hint is the lesser evil.
  }
}

/** Remove the journal entry (confirmed receipt). No-op when `path` is undefined. */
export function clearJournal(path: string | undefined): void {
  if (!path) return;
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    // Swallow — a leftover entry will simply be re-reconciled (idempotently) at
    // the next startup, which is harmless.
  }
}

/**
 * Read the journal entry, or `undefined` if there is none / it's unreadable /
 * corrupt. Validates shape so a partially-written file can't crash reconciliation.
 */
export function readJournal(path: string | undefined): TxJournalEntry | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TxJournalEntry>;
    if (
      typeof parsed.txHash === "string" &&
      /^0x[0-9a-fA-F]+$/.test(parsed.txHash) &&
      (parsed.kind === "derisk" || parsed.kind === "rebalance") &&
      typeof parsed.deRiskRequired === "boolean" &&
      typeof parsed.sentAt === "string"
    ) {
      return parsed as TxJournalEntry;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Minimal publicClient surface the reconciler needs (viem-compatible). */
export interface ReconcileClient {
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status?: string } | null>;
  waitForTransactionReceipt: (args: {
    hash: `0x${string}`;
    timeout?: number;
  }) => Promise<{ status?: string }>;
}

export interface ReconcileDeps {
  /** Log a human line (info-level). */
  readonly log: (msg: string) => void;
  /**
   * Fire a CRITICAL alert when a REQUIRED de-risk was in flight at the crash and
   * could not be confirmed at startup. Must never throw.
   */
  readonly alertFailure: (entry: TxJournalEntry, detail: string) => Promise<void> | void;
  /** Receipt-wait timeout (ms) for a still-pending tx. */
  readonly timeoutMs: number;
}

/**
 * O4 — startup crash recovery. If a journal entry survived a crash, look up its
 * receipt:
 *   - confirmed (any status) → log + clear and move on.
 *   - not found / still pending → wait (bounded) for a receipt; on success log +
 *     clear; on failure/timeout log and, if it was a REQUIRED de-risk, fire a
 *     CRITICAL alert (the vault may still be exposed) before clearing.
 *
 * Always clears the journal at the end (the in-flight tx has been accounted for,
 * one way or another) and never throws — a recovery hiccup must not block boot.
 */
export async function reconcileJournal(
  path: string | undefined,
  client: ReconcileClient,
  deps: ReconcileDeps,
): Promise<void> {
  const entry = readJournal(path);
  if (!entry) return;

  deps.log(
    `tx-journal: found an unfinished ${entry.kind} tx ${entry.txHash} (sent ${entry.sentAt}, deRiskRequired=${entry.deRiskRequired}) — reconciling`,
  );

  try {
    const receipt = await client.getTransactionReceipt({ hash: entry.txHash }).catch(() => null);
    if (receipt) {
      deps.log(`tx-journal: ${entry.txHash} already confirmed (status=${receipt.status ?? "unknown"}); clearing`);
      clearJournal(path);
      return;
    }

    // Not found / pending — wait for it within the configured bound.
    const confirmed = await client.waitForTransactionReceipt({ hash: entry.txHash, timeout: deps.timeoutMs });
    if (confirmed.status === "reverted") {
      const detail = `tx ${entry.txHash} reverted on-chain`;
      deps.log(`tx-journal: ${detail}`);
      if (entry.deRiskRequired) await deps.alertFailure(entry, detail);
    } else {
      deps.log(`tx-journal: ${entry.txHash} confirmed at startup (status=${confirmed.status ?? "unknown"})`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log(`tx-journal: ${entry.txHash} did NOT confirm (${detail})`);
    if (entry.deRiskRequired) await deps.alertFailure(entry, detail);
  } finally {
    clearJournal(path);
  }
}
