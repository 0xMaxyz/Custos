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
});
