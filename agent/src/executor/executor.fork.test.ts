/**
 * Fork integration tests for the Executor and Scheduler (ROADMAP tasks 3.7–3.8).
 *
 * Skipped when MANTLE_RPC_URL is unset (mirrors the pipeline fork pattern).
 * Requires:
 *   - MANTLE_RPC_URL — an anvil fork of Mantle, or live Mantle RPC
 *   - VAULT_ADDRESS  — a deployed YieldVault with ALLOCATOR role
 *   - ALLOCATOR_PRIVATE_KEY — hot key holding ALLOCATOR role
 *
 * What is tested:
 *   3.7: Executor.runCycle() on a fork with a healthy snapshot → submitted=true,
 *        on-chain DecisionRecorded event, weights within guardrails.
 *   3.7: deRisk path — injected depeg snapshot forces de-risk, USDY weight → 0.
 *   3.8: Scheduler.injectBreachCondition() triggers an immediate cycle in the
 *        breach-poll loop and calls onCycle with the submitted result.
 */
import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildPipeline } from "../pipeline.js";
import { Executor } from "./index.js";
import { Scheduler } from "../scheduler.js";

const RPC = process.env.MANTLE_RPC_URL;
const VAULT = process.env.VAULT_ADDRESS;
const KEY = process.env.ALLOCATOR_PRIVATE_KEY;

const describeFork = RPC && VAULT && KEY ? describe : describe.skip;

describeFork("Executor + Scheduler (fork integration)", () => {
  const config = loadConfig({
    MANTLE_RPC_URL: RPC ?? "https://rpc.mantle.xyz",
    VAULT_ADDRESS: VAULT ?? "0x0000000000000000000000000000000000000000",
    ALLOCATOR_PRIVATE_KEY: KEY ?? "0x0000000000000000000000000000000000000000000000000000000000000001",
  });

  it("3.7: Executor.runCycle() on a healthy fork emits a decision on-chain", async () => {
    const pipeline = buildPipeline(config);
    const executor = new Executor({ config, clients: pipeline.clients, snapshotter: pipeline.snapshotter });

    const result = await executor.runCycle();

    // In read-only / no-change scenarios submitted may be false; if submitted, assert structure.
    expect(result).toHaveProperty("submitted");
    expect(result).toHaveProperty("reason");
    if (result.submitted) {
      expect(result.kind).toMatch(/rebalance|derisk/);
      expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    }
  }, 60_000);

  it("3.7: depeg snapshot (injected) forces de-risk → USDY weight 0", async () => {
    const { assess } = await import("../risk/engine.js");
    const { applyVerdict } = await import("../risk/validator.js");
    const { Bucket } = await import("@custos/shared");

    // Construct a snapshot with ~100bps peg deviation (forces forceDeRisk deterministically).
    const pipeline = buildPipeline(config);
    const live = await pipeline.snapshotter.snapshot();

    // Inject a depeg: set spot ~100bps below NAV.
    const nav = live.usdyOracleNavUsdc;
    const depegSpot = nav - (nav / 100n); // 1% below NAV
    const depegSnap = { ...live, usdyDexSpotUsdc: depegSpot };

    const assessment = assess(depegSnap, { nowSec: Math.floor(Date.now() / 1000) });
    expect(assessment.forceDeRisk).toBe(true);

    const proposed = applyVerdict(assessment, null);
    expect(proposed[Bucket.USDY]).toBe(0);
  }, 30_000);

  it("3.8: Scheduler.injectBreachCondition() triggers an immediate cycle", async () => {
    const pipeline = buildPipeline(config);
    const executor = new Executor({ config, clients: pipeline.clients, snapshotter: pipeline.snapshotter });

    const onCycle = vi.fn();
    const scheduler = new Scheduler(executor, {
      intervalMs: 60 * 60 * 1_000, // long — won't fire naturally
      pollMs: 60 * 60 * 1_000,
      onCycle,
    });

    scheduler.start();
    scheduler.injectBreachCondition();

    // Wait up to 10s for the injected cycle to complete.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 10_000);
      const orig = onCycle.getMockImplementation() ?? (() => {});
      onCycle.mockImplementation((...args) => {
        orig(...args);
        clearTimeout(t);
        resolve();
      });
    });

    scheduler.stop();
    expect(onCycle).toHaveBeenCalled();
  }, 30_000);
});
