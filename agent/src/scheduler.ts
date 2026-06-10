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
  /** Called at debug verbosity (default: no-op). Used for skipped-cycle traces. */
  readonly onDebug?: (msg: string) => void;
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
  private readonly onDebug: (msg: string) => void;

  private _running = false;
  private _periodicTimer: ReturnType<typeof setTimeout> | undefined;
  private _pollTimer: ReturnType<typeof setTimeout> | undefined;

  // Demo-trigger: set to true by injectBreachCondition() to force an immediate poll.
  private _breachPending = false;

  // Single in-flight guard (O3): the periodic and breach-poll loops share no
  // mutex, so a poll fired by injectBreachCondition() mid-interval could otherwise
  // run runCycle() concurrently with the periodic loop. While a cycle is in
  // flight, any other trigger skips (with a debug log) rather than queuing — the
  // next scheduled tick will pick up fresh state.
  private _inFlight = false;

  constructor(executor: Executor, opts: SchedulerOptions = {}) {
    this.executor = executor;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1_000;
    this.pollMs = opts.pollMs ?? 30_000;
    this.onCycle = opts.onCycle ?? (() => {});
    this.onError = opts.onError ?? ((e) => console.error("[scheduler]", e));
    this.onDebug = opts.onDebug ?? (() => {});
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

  /**
   * Run a cycle iff none is already in flight (O3). Returns true if it ran the
   * cycle (the caller owns onCycle/onError dispatch), false if it skipped because
   * a cycle was already running. The in-flight flag is held for the whole
   * `runCycle()` so the two loops can never invoke the executor concurrently.
   */
  private async _runGuarded(
    label: "periodic" | "poll",
    handle: (result: CycleResult) => void,
  ): Promise<boolean> {
    if (this._inFlight) {
      this.onDebug(`[scheduler] ${label} tick skipped: a cycle is already in flight`);
      return false;
    }
    this._inFlight = true;
    try {
      const result = await this.executor.runCycle();
      handle(result);
    } catch (e) {
      this.onError(e);
    } finally {
      this._inFlight = false;
    }
    return true;
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
    await this._runGuarded("periodic", (result) => this.onCycle(result));
    this._schedulePeriodic();
  }

  private async _runPoll(): Promise<void> {
    const wasBreachPending = this._breachPending;
    this._breachPending = false;
    await this._runGuarded("poll", (result) => {
      // Notify on a submitted decision, or whenever a breach was explicitly injected.
      if (result.submitted || wasBreachPending) {
        this.onCycle(result);
      }
    });
    this._schedulePoll();
  }
}
