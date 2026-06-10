/**
 * Governance-event watcher tests (mocked publicClient — no network).
 *
 * With the short 6h launch timelock, a queued/cancelled/activated guardrail change
 * must page the operator. We assert: one matching log → notifier called with a
 * message containing the event name; empty logs → no alert; a throwing getLogs is
 * swallowed (logged) and the watcher keeps going.
 */
import { describe, it, expect, vi } from "vitest";
import { GovernanceWatcher } from "./governanceWatch.js";

const GUARDRAILS = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT = "0x2222222222222222222222222222222222222222" as `0x${string}`;

function makeNotifier() {
  const notifyGovernance = vi.fn(async () => {});
  return { notifier: { notifyGovernance, isConfigured: true } as never, notifyGovernance };
}

describe("GovernanceWatcher", () => {
  it("one matching log → notifyGovernance called with a message containing the event name", async () => {
    const { notifier, notifyGovernance } = makeNotifier();
    const getLogs = vi.fn(async () => [
      { eventName: "ConfigQueued", blockNumber: 4242n, transactionHash: "0xabc" },
    ]);
    const getBlockNumber = vi.fn(async () => 4200n);
    const publicClient = { getBlockNumber, getLogs } as never;

    const w = new GovernanceWatcher({
      publicClient,
      guardrailsAddress: GUARDRAILS,
      alertNotifier: notifier,
      pollMs: 60_000,
    });
    // Simulate: head advanced past the start point, then a poll.
    await w.start(); // fromBlock = 4201
    getBlockNumber.mockResolvedValue(4300n); // head advanced
    await w._poll();

    expect(notifyGovernance).toHaveBeenCalled();
    const msg = (notifyGovernance.mock.calls[0] as unknown as [string])[0];
    expect(msg).toContain("ConfigQueued");
    expect(msg).toContain("Guardrails");
    expect(msg).toContain("4242");
    w.stop();
  });

  it("empty logs → no alert fired", async () => {
    const { notifier, notifyGovernance } = makeNotifier();
    const getLogs = vi.fn(async () => []);
    const getBlockNumber = vi.fn(async () => 100n);
    const publicClient = { getBlockNumber, getLogs } as never;

    const w = new GovernanceWatcher({ publicClient, guardrailsAddress: GUARDRAILS, alertNotifier: notifier });
    await w.start();
    getBlockNumber.mockResolvedValue(200n);
    await w._poll();

    expect(getLogs).toHaveBeenCalled();
    expect(notifyGovernance).not.toHaveBeenCalled();
    w.stop();
  });

  it("getLogs throwing is swallowed (logged via onError); watcher keeps going", async () => {
    const { notifier, notifyGovernance } = makeNotifier();
    const getLogs = vi.fn(async () => { throw new Error("getLogs range exceeded"); });
    const getBlockNumber = vi.fn(async () => 100n);
    const onError = vi.fn();
    const publicClient = { getBlockNumber, getLogs } as never;

    const w = new GovernanceWatcher({ publicClient, guardrailsAddress: GUARDRAILS, alertNotifier: notifier, onError });
    await w.start();
    getBlockNumber.mockResolvedValue(200n);
    // Must not throw out of _poll.
    await expect(w._poll()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(notifyGovernance).not.toHaveBeenCalled();
    w.stop();
  });

  it("watches the vault address too when configured", async () => {
    const { notifier, notifyGovernance } = makeNotifier();
    const seenAddresses: string[] = [];
    const getLogs = vi.fn(async (args: { address: string }) => {
      seenAddresses.push(args.address);
      return args.address === VAULT
        ? [{ eventName: "GuardrailsQueued", blockNumber: 5n, transactionHash: "0xdef" }]
        : [];
    });
    const getBlockNumber = vi.fn(async () => 1n);
    const publicClient = { getBlockNumber, getLogs } as never;

    const w = new GovernanceWatcher({
      publicClient, guardrailsAddress: GUARDRAILS, vaultAddress: VAULT, alertNotifier: notifier,
    });
    await w.start();
    getBlockNumber.mockResolvedValue(50n);
    await w._poll();

    expect(seenAddresses).toContain(GUARDRAILS);
    expect(seenAddresses).toContain(VAULT);
    const msg = (notifyGovernance.mock.calls[0] as unknown as [string])[0];
    expect(msg).toContain("GuardrailsQueued");
    expect(msg).toContain("YieldVault");
    w.stop();
  });

  it("no historical backfill: a poll with head == start point scans nothing", async () => {
    const { notifier, notifyGovernance } = makeNotifier();
    const getLogs = vi.fn(async () => []);
    const getBlockNumber = vi.fn(async () => 1000n);
    const publicClient = { getBlockNumber, getLogs } as never;

    const w = new GovernanceWatcher({ publicClient, guardrailsAddress: GUARDRAILS, alertNotifier: notifier });
    await w.start(); // fromBlock = 1001
    // Head hasn't advanced past fromBlock → nothing to scan.
    await w._poll();
    expect(getLogs).not.toHaveBeenCalled();
    expect(notifyGovernance).not.toHaveBeenCalled();
    w.stop();
  });
});
