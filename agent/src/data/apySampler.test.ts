import { describe, it, expect } from "vitest";

import { ApySampler } from "./apySampler.js";

describe("ApySampler", () => {
  it("returns the seed APY on the first sample", () => {
    const s = new ApySampler({ seedApyBps: 450, now: () => 0 });
    expect(s.sample(1_000_000_000_000_000_000n)).toBe(450);
  });

  it("annualizes drift on the second sample", () => {
    let t = 0;
    const s = new ApySampler({ seedApyBps: 450, now: () => t });
    s.sample(1_000_000_000_000_000_000n); // seed
    t = 24 * 3_600; // +1 day
    // +0.01% over a day → ~365 bps annualized
    expect(s.sample(1_000_100_000_000_000_000n)).toBe(365);
  });

  it("falls back to the seed on a flat/regressing sample", () => {
    let t = 0;
    const s = new ApySampler({ seedApyBps: 400, now: () => t });
    s.sample(1_000_000_000_000_000_000n);
    t = 3_600;
    expect(s.sample(1_000_000_000_000_000_000n)).toBe(400); // no growth
  });
});
