import { describe, it, expect } from "vitest";
import * as fmt from "./fmt";

describe("usd", () => {
  it("formats with cents and dollar sign", () => {
    expect(fmt.usd("30142.50")).toBe("$30,142.50");
    expect(fmt.usd(1000)).toBe("$1,000.00");
  });
  it("drops cents when cents:false", () => {
    expect(fmt.usd(50000, { cents: false })).toBe("$50,000");
  });
  it("adds a leading + for positive when sign:true", () => {
    expect(fmt.usd(142.5, { sign: true })).toBe("+$142.50");
    expect(fmt.usd(-142.5, { sign: true })).toBe("$-142.50");
  });
});

describe("bps helpers", () => {
  it("bpsToPct converts basis points to percent", () => {
    expect(fmt.bpsToPct(418)).toBe("4.18%");
  });
  it("pctSigned prefixes + for positive", () => {
    expect(fmt.pctSigned(180)).toBe("+1.80%");
    expect(fmt.pctSigned(-50)).toBe("-0.50%");
  });
  it("bpsSigned renders signed bps label", () => {
    expect(fmt.bpsSigned(45)).toBe("+45 bps");
    expect(fmt.bpsSigned(-12)).toBe("-12 bps");
  });
  it("bpsToWeight rounds bps to whole-percent weight", () => {
    expect(fmt.bpsToWeight(5000)).toBe(50);
    expect(fmt.bpsToWeight(4700)).toBe(47);
  });
});

describe("address helpers", () => {
  it("shortAddr truncates the middle", () => {
    expect(fmt.shortAddr("0xA11c3b9D7e2F4a8c6B0d1E5f9A3c7B2d4E6f8A0E")).toBe("0xA11c…8A0E");
  });
  it("shortAddr leaves short strings untouched", () => {
    expect(fmt.shortAddr("0x1234")).toBe("0x1234");
  });
});

describe("price", () => {
  it("formats to 4dp by default", () => {
    expect(fmt.price("1.0047")).toBe("$1.0047");
  });
});

describe("timeAgo", () => {
  it("renders seconds / minutes / hours / days", () => {
    const now = Date.now();
    expect(fmt.timeAgo(new Date(now - 5_000).toISOString())).toMatch(/s ago$/);
    expect(fmt.timeAgo(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(fmt.timeAgo(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(fmt.timeAgo(new Date(now - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
});
