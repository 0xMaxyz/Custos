import type { Executor, CycleResult } from "./executor/index.js";

export interface SchedulerOptions {
  /** Milliseconds between periodic rebalance cycles. Default: 60 minutes. */
  readonly intervalMs?: number;
  /**
   * Milliseconds between breach-detection polls (depeg / oracle / utilization).
   * Default: 30 seconds — fast enough to catch an RWA event before the next cycle.
   */
  readonly pollMs?: number;
  /** Called after each cycle completes (useful for metrics / demo UI). */
  readonly onCycle?: (result: CycleResult) => void;
  /** Called on unexpected errors (default: console.error). */
  readonly onError?: (err: unknown) => void;
}

/**
 * Autonomous agent scheduler (ROADMAP task 3.8).
 *
 * Two interleaved loops:
 *
 * 1. **Periodic loop** — runs a full `Executor.runCycle()` on `intervalMs`
 *    (default 60 min). Covers normal yield-optimisation rebalances.
 *
 * 2. **Breach-poll loop** — runs `Executor.runCycle()` every `pollMs` (default
 *    30 s). The executor's deterministic `assess()` will fire `forceDeRisk` on
 *    peg/oracle breach and call `deRisk()` immediately, regardless of the rebalance
 *    interval (de-risk is exempt from the frequency cap on-chain).
 *
 * A **demo-trigger harness** (`injectBreachCondition`) allows fork tests to signal
 * a forced breach poll without waiting for the real interval. This is the hook the
 * integration test uses to simulate an injected de-risk event.
 */
export class Scheduler {
  private readonly executor: Executor;
  private readonly intervalMs: number;
  private readonly pollMs: number;
  private readonly onCycle: (r: CycleResult) => void;
  private readonly onError: (e: unknown) => void;

  private _running = false;
  private _periodicTimer: ReturnType<typeof setTimeout> | undefined;
  private _pollTimer: ReturnType<typeof setTimeout> | undefined;

  // Demo-trigger: set to true by injectBreachCondition() to force an immediate poll.
  private _breachPending = false;

  constructor(executor: Executor, opts: SchedulerOptions = {}) {
    this.executor = executor;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1_000;
    this.pollMs = opts.pollMs ?? 30_000;
    this.onCycle = opts.onCycle ?? (() => {});
    this.onError = opts.onError ?? ((e) => console.error("[scheduler]", e));
  }

  /** Start both loops. Idempotent — safe to call multiple times. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._schedulePeriodic();
    this._schedulePoll();
  }

  /** Stop both loops and clear all pending timers. */
  stop(): void {
    this._running = false;
    clearTimeout(this._periodicTimer);
    clearTimeout(this._pollTimer);
    this._periodicTimer = undefined;
    this._pollTimer = undefined;
  }

  /**
   * Demo-trigger harness: force an immediate breach-detection poll.
   * Used by fork integration tests to simulate an injected depeg/oracle event
   * without waiting for the real poll interval.
   */
  injectBreachCondition(): void {
    this._breachPending = true;
    // Cancel the pending poll timer and run immediately.
    clearTimeout(this._pollTimer);
    this._pollTimer = undefined;
    void this._runPoll();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _schedulePeriodic(): void {
    if (!this._running) return;
    this._periodicTimer = setTimeout(() => {
      void this._runPeriodic();
    }, this.intervalMs);
  }

  private _schedulePoll(): void {
    if (!this._running) return;
    this._pollTimer = setTimeout(() => {
      void this._runPoll();
    }, this.pollMs);
  }

  private async _runPeriodic(): Promise<void> {
    try {
      const result = await this.executor.runCycle();
      this.onCycle(result);
    } catch (e) {
      this.onError(e);
    }
    this._schedulePeriodic();
  }

  private async _runPoll(): Promise<void> {
    const wasBreachPending = this._breachPending;
    this._breachPending = false;
    try {
      // Only run if a breach was injected or this is a routine poll.
      const result = await this.executor.runCycle();
      if (result.submitted || wasBreachPending) {
        this.onCycle(result);
      }
    } catch (e) {
      this.onError(e);
    }
    this._schedulePoll();
  }
}
