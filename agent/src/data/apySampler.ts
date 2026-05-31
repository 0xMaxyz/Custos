import { impliedApyBps } from "./readers.js";

/**
 * Derives USDY-implied APY from successive oracle NAV samples. The Ondo oracle
 * exposes only an instantaneous NAV, so APY is the annualized drift between two
 * readings. Holds the last sample in memory across decision cycles.
 *
 * Until a second sample exists, returns a configurable seed APY so the first
 * cycle has a sane value rather than 0 (which would make the engine drop USDY).
 */
export class ApySampler {
  private last?: { navUsdc: bigint; atSec: number };
  private readonly seedApyBps: number;
  private readonly now: () => number;

  constructor(options: { seedApyBps?: number; now?: () => number } = {}) {
    this.seedApyBps = options.seedApyBps ?? 450; // ~4.5% default until measured
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Record a NAV reading and return the best APY estimate (bps). */
  sample(navUsdc: bigint): number {
    const atSec = this.now();
    const prev = this.last;
    this.last = { navUsdc, atSec };

    if (prev === undefined || atSec <= prev.atSec) {
      return this.seedApyBps;
    }
    const apy = impliedApyBps(prev.navUsdc, navUsdc, atSec - prev.atSec);
    // A flat/regressing sample (rounding, intra-block) falls back to the seed.
    return apy > 0 ? apy : this.seedApyBps;
  }
}
