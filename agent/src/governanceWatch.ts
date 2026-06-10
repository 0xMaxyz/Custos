import type { PublicClient, AbiEvent } from "viem";

import { guardrailsEventsAbi, yieldVaultGovernanceEventsAbi } from "./chain/abis.js";
import type { AlertNotifier } from "./alerts.js";

/**
 * Governance-event watcher.
 *
 * The mainnet launch runs a short (6h) timelock, so visibility into queued
 * config changes is itself a security control: an operator must be paged the
 * moment someone queues, cancels, or activates a guardrail change — there isn't
 * a 48h cushion to notice it manually.
 *
 * This polls `getLogs` for the relevant Guardrails / YieldVault events from the
 * last processed block onward (no historical backfill — we start at the current
 * head on boot, mindful of Mantle RPC getLogs range limits). On any matching
 * event it fires a critical-style alert via `AlertNotifier.notifyGovernance`.
 *
 * Plain `setTimeout` polling, consistent with the scheduler. Resilient: a
 * `getLogs` failure (RPC blip, range limit) is logged and swallowed — the
 * watcher keeps going and retries on the next tick rather than crashing the agent.
 */

export interface GovernanceWatchOptions {
  readonly publicClient: PublicClient;
  readonly guardrailsAddress: `0x${string}`;
  /** Optional — when set, YieldVault guardrails-swap events are watched too. */
  readonly vaultAddress?: `0x${string}` | undefined;
  readonly alertNotifier: AlertNotifier;
  /** Poll interval (ms). Default 60s. */
  readonly pollMs?: number;
  /** Log a debug/info line (default: no-op). */
  readonly onError?: (err: unknown) => void;
  readonly onDebug?: (msg: string) => void;
}

interface WatchedSource {
  readonly label: string;
  readonly address: `0x${string}`;
  readonly events: readonly AbiEvent[];
}

const GUARDRAILS_EVENTS = guardrailsEventsAbi.filter((e) => e.type === "event") as readonly AbiEvent[];
const VAULT_EVENTS = yieldVaultGovernanceEventsAbi.filter((e) => e.type === "event") as readonly AbiEvent[];

export class GovernanceWatcher {
  private readonly publicClient: PublicClient;
  private readonly alertNotifier: AlertNotifier;
  private readonly sources: WatchedSource[];
  private readonly pollMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly onDebug: (msg: string) => void;

  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  // Next block to scan FROM (inclusive). Set to current head + 1 on start so we
  // never backfill history (keeps within Mantle getLogs range limits).
  private _fromBlock: bigint | undefined;

  constructor(opts: GovernanceWatchOptions) {
    this.publicClient = opts.publicClient;
    this.alertNotifier = opts.alertNotifier;
    this.pollMs = opts.pollMs ?? 60_000;
    this.onError = opts.onError ?? (() => {});
    this.onDebug = opts.onDebug ?? (() => {});

    this.sources = [
      { label: "Guardrails", address: opts.guardrailsAddress, events: GUARDRAILS_EVENTS },
    ];
    if (opts.vaultAddress) {
      this.sources.push({ label: "YieldVault", address: opts.vaultAddress, events: VAULT_EVENTS });
    }
  }

  /** Start polling. Snapshots the current head so there's no historical backfill. */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const head = await this.publicClient.getBlockNumber();
      this._fromBlock = head + 1n;
    } catch (err) {
      // Couldn't read the head — start from undefined and let the first poll set it.
      this.onError(err);
    }
    this._schedule();
  }

  stop(): void {
    this._running = false;
    clearTimeout(this._timer);
    this._timer = undefined;
  }

  private _schedule(): void {
    if (!this._running) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      void this._poll();
    }, this.pollMs);
  }

  /** One poll cycle: scan [fromBlock, head] for each source's events. */
  async _poll(): Promise<void> {
    try {
      const head = await this.publicClient.getBlockNumber();
      // First poll if start() couldn't read the head: begin at head, no backfill.
      if (this._fromBlock === undefined) this._fromBlock = head + 1n;
      if (head >= this._fromBlock) {
        const from = this._fromBlock;
        for (const src of this.sources) {
          await this._scanSource(src, from, head);
        }
        this._fromBlock = head + 1n;
      }
    } catch (err) {
      // RPC blip / range limit — log and keep going; the next tick retries.
      this.onError(err);
    } finally {
      this._schedule();
    }
  }

  private async _scanSource(src: WatchedSource, from: bigint, to: bigint): Promise<void> {
    let logs;
    try {
      logs = await this.publicClient.getLogs({
        address: src.address,
        events: src.events,
        fromBlock: from,
        toBlock: to,
      });
    } catch (err) {
      // Swallow per-source so one failing address doesn't stop the others.
      this.onError(err);
      return;
    }
    for (const log of logs) {
      const eventName = (log as { eventName?: string }).eventName ?? "UnknownEvent";
      const block = (log as { blockNumber?: bigint }).blockNumber;
      const tx = (log as { transactionHash?: string }).transactionHash;
      const message =
        `🟣 Governance change ${eventName} on ${src.label}` +
        (block !== undefined ? ` at block ${block.toString()}` : "") +
        (tx ? `, tx ${tx}` : "");
      this.onDebug(`[governance] ${message}`);
      // notifyGovernance never throws, but guard anyway so a delivery hiccup
      // can't abort scanning the remaining logs.
      try {
        await this.alertNotifier.notifyGovernance(message);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
