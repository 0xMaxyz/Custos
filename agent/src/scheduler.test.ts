import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "./scheduler.js";
import type { CycleResult } from "./executor/index.js";
import type { Executor } from "./executor/index.js";

function makeExecutor(overrides: Partial<Pick<Executor, "runCycle">> = {}): Executor {
  return {
    runCycle: vi.fn(async (): Promise<CycleResult> => ({
      submitted: false,
      reason: "No allocation change needed",
    })),
    ...overrides,
  } as unknown as Executor;
}

describe("Scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls runCycle after the periodic interval", async () => {
    const executor = makeExecutor();
    const scheduler = new Scheduler(executor, { intervalMs: 1_000, pollMs: 60_000 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(executor.runCycle).toHaveBeenCalled();
    scheduler.stop();
  });

  it("calls runCycle on each poll tick", async () => {
    const executor = makeExecutor();
    const scheduler = new Scheduler(executor, { intervalMs: 60_000, pollMs: 500 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_100);
    // Should have ticked at ~500ms and ~1000ms.
    expect((executor.runCycle as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    scheduler.stop();
  });

  it("stop() prevents further runCycle calls", async () => {
    const executor = makeExecutor();
    const scheduler = new Scheduler(executor, { intervalMs: 500, pollMs: 500 });
    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(executor.runCycle).not.toHaveBeenCalled();
  });

  it("start() is idempotent — second call does not double-schedule", async () => {
    const executor = makeExecutor();
    const scheduler = new Scheduler(executor, { intervalMs: 60_000, pollMs: 500 });
    scheduler.start();
    scheduler.start(); // second call should be no-op

    await vi.advanceTimersByTimeAsync(600);
    // Only one poll tick, not two.
    expect((executor.runCycle as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
    scheduler.stop();
  });

  it("injectBreachCondition() triggers an immediate cycle and notifies onCycle", async () => {
    const cycleResult: CycleResult = { submitted: true, kind: "derisk", reason: "Breach" };
    const executor = makeExecutor({
      runCycle: vi.fn(async () => cycleResult),
    });
    const onCycle = vi.fn();
    const scheduler = new Scheduler(executor, { intervalMs: 60_000, pollMs: 60_000, onCycle });
    scheduler.start();

    scheduler.injectBreachCondition();
    await vi.advanceTimersByTimeAsync(10);

    expect(executor.runCycle).toHaveBeenCalled();
    expect(onCycle).toHaveBeenCalledWith(cycleResult);
    scheduler.stop();
  });

  it("onError() is called when runCycle throws", async () => {
    const executor = makeExecutor({
      runCycle: vi.fn(async () => { throw new Error("RPC down"); }),
    });
    const onError = vi.fn();
    const scheduler = new Scheduler(executor, { intervalMs: 60_000, pollMs: 300, onError });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalled();
    scheduler.stop();
  });

  // ── O3: single in-flight guard — loops never run runCycle concurrently ────────

  it("skips a second trigger while a cycle is in flight (O3)", async () => {
    // A long-running cycle that resolves only when we release it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const runCycle = vi.fn(async (): Promise<CycleResult> => {
      started += 1;
      await gate;
      return { submitted: false, reason: "done" };
    });
    const executor = makeExecutor({ runCycle });
    const onDebug = vi.fn();
    // Poll fires fast; periodic also fires — but only one cycle may run at a time.
    const scheduler = new Scheduler(executor, { intervalMs: 50, pollMs: 50, onDebug });
    scheduler.start();

    // Let the first tick start the cycle; a concurrent tick fires while it's held.
    await vi.advanceTimersByTimeAsync(120);
    expect(started).toBe(1); // second tick was skipped, not run concurrently
    expect(onDebug).toHaveBeenCalled(); // skip was logged at debug

    // Release the in-flight cycle and let timers settle.
    release();
    await vi.advanceTimersByTimeAsync(60);
    scheduler.stop();
  });

  it("injectBreachCondition() skips (with debug log) when a cycle is already in flight (O3)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const runCycle = vi.fn(async (): Promise<CycleResult> => {
      started += 1;
      await gate;
      return { submitted: true, kind: "derisk", reason: "Breach" };
    });
    const executor = makeExecutor({ runCycle });
    const onDebug = vi.fn();
    const scheduler = new Scheduler(executor, { intervalMs: 60_000, pollMs: 60_000, onDebug });
    scheduler.start();

    // First breach starts a (held) cycle; the second must be skipped, not queued.
    scheduler.injectBreachCondition();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.injectBreachCondition();
    await vi.advanceTimersByTimeAsync(1);

    expect(started).toBe(1);
    expect(onDebug).toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stop();
  });
});
