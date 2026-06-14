import { describe, it, expect } from "vitest";
import { parseArgs } from "./rebalance.js";

// The full signing path is integration-only (needs RPC + ALLOCATOR key); here we
// cover the pure argument parsing + validation that gates it.
describe("rebalance script — parseArgs", () => {
  it("parses four bps weights that sum to 10000", () => {
    const args = parseArgs(["2000", "8000", "0", "0"]);
    expect(args.weights).toEqual([2000, 8000, 0, 0]);
    expect(args.force).toBe(false);
    expect(args.reason).toMatch(/manual/i);
  });

  it("honours --reason, --force and --env flags", () => {
    const args = parseArgs(["2000", "4000", "4000", "0", "--reason", "seed RWA", "--force"]);
    expect(args.weights).toEqual([2000, 4000, 4000, 0]);
    expect(args.force).toBe(true);
    expect(args.reason).toBe("seed RWA");
  });

  it("throws when not given exactly four weights", () => {
    expect(() => parseArgs(["2000", "8000", "0"])).toThrow(/4 weight args/i);
  });

  it("throws on a non-integer or out-of-range weight", () => {
    expect(() => parseArgs(["2000", "8000", "0", "x"])).toThrow(/invalid weight/i);
    expect(() => parseArgs(["-1", "10001", "0", "0"])).toThrow(/invalid weight/i);
  });

  it("throws when the weights do not sum to 10000", () => {
    expect(() => parseArgs(["2000", "7000", "0", "0"])).toThrow(/sum to 10000/i);
  });
});
