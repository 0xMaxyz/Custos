// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Roles} from "./Roles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Guardrails
 * @notice On-chain guardrail parameter store and pure validation helpers.
 *
 * Numeric defaults mirror packages/shared/src/guardrails.ts exactly — the TS
 * validator and this contract share the same source of truth so they never
 * drift. Any change here must be reflected in the TS constants.
 *
 * The LLM/agent may only TIGHTEN risk (lower caps, raise minimums). It never
 * calls this contract directly — only ADMIN can reconfigure.
 */
contract Guardrails is AccessControl {
    // ── Errors ────────────────────────────────────────────────────────────────

    error WeightsSumNot10000();
    error WeightExceedsCap(uint8 bucket);
    error IdleBufferTooLow();
    error InstantLiquidityTooLow();
    error RebalanceIntervalNotElapsed();
    error RebalanceMoveTooLarge();
    error UsdyAllocationBlocked();
    error UsdySpotRequired();
    error InvalidBucket();
    error TimelockNotElapsed();
    error InvalidConfig();

    // ── Events ────────────────────────────────────────────────────────────────

    event ConfigUpdated(Config newConfig);

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Config {
        // Allocation limits
        uint16[4] maxWeightBps;        // per bucket; index = Bucket id
        uint16    minIdleBps;          // min IDLE fraction of TVL (bps)
        uint16    minInstantLiquidityBps; // min (IDLE + Aave-withdrawable) fraction (bps)
        // Execution safety
        uint16    maxSlippageBps;
        uint16    maxRebalanceMoveBps;
        uint32    minRebalanceInterval; // seconds
        uint256   tvlCap;              // 6-dec USDC
        uint256   perTxDepositCap;     // 6-dec USDC
        uint32    addStrategyTimelock; // seconds
        // USDY risk thresholds
        uint16    pegWarnBps;
        uint16    pegBlockBps;
        uint16    pegDeRiskBps;
        uint32    oracleMaxAge;        // seconds
        uint32    oracleRangeEndBuffer; // seconds
    }

    struct MarketState {
        uint256 usdyOracleNav;     // USDC per USDY (18-dec oracle price)
        uint256 usdyDexSpot;       // USDC per USDY (18-dec DEX quote)
        uint64  oracleUpdatedAt;   // unix timestamp of last oracle update
        uint64  oracleRangeEnd;    // unix timestamp when oracle range expires
        uint256 aaveWithdrawable;  // current USDC withdrawable from Aave (6-dec)
        uint256 totalAssets;       // vault TVL in 6-dec USDC
        uint64  lastRebalanceAt;   // unix timestamp of last rebalance
    }

    // ── Constants (default values — match packages/shared/src/guardrails.ts) ──

    uint16 private constant _IDLE = 0;
    uint16 private constant _AAVE = 1;
    uint16 private constant _USDY = 2;
    uint16 private constant _AUSD = 3;
    uint16 private constant _BPS  = 10_000;

    // ── State ─────────────────────────────────────────────────────────────────

    Config private _config;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN, admin);

        // Set defaults from packages/shared/src/guardrails.ts
        uint16[4] memory maxW;
        maxW[_IDLE] = 10_000; // no upper cap on idle
        maxW[_AAVE] = 9_000;  // 90%
        maxW[_USDY] = 6_000;  // 60%
        maxW[_AUSD] = 10_000; // 100%

        _config = Config({
            maxWeightBps:           maxW,
            minIdleBps:             200,     // 2%
            minInstantLiquidityBps: 1_500,   // 15%
            maxSlippageBps:         50,      // 0.5%
            maxRebalanceMoveBps:    5_000,   // 50%
            minRebalanceInterval:   3_600,   // 1h
            tvlCap:                 50_000 * 1e6,  // $50k
            perTxDepositCap:        10_000 * 1e6,  // $10k
            addStrategyTimelock:    2 days,
            pegWarnBps:             30,      // 0.3%
            pegBlockBps:            50,      // 0.5%
            pegDeRiskBps:           100,     // 1.0%
            oracleMaxAge:           100_800, // ~28h
            oracleRangeEndBuffer:   86_400   // 24h
        });
    }

    // ── Config management ─────────────────────────────────────────────────────

    /// @notice Replace the entire guardrail config. Only ADMIN.
    function setConfig(Config calldata newConfig) external onlyRole(Roles.ADMIN) {
        _requireValidConfig(newConfig);
        _config = newConfig;
        emit ConfigUpdated(newConfig);
    }

    /// @notice Read the current config.
    function config() external view returns (Config memory) {
        return _config;
    }

    // ── Validation helpers ────────────────────────────────────────────────────

    /**
     * @notice Pure check of a proposed rebalance against current config + market state.
     * @param preWeightsBps  Current allocation weights (must sum to 10000).
     * @param postWeightsBps Proposed allocation weights (must sum to 10000).
     * @param s              Current market state snapshot.
     * @return ok     True when the proposal passes all guardrail checks.
     * @return reason 4-byte selector of the revert error if !ok; 0 if ok.
     */
    function validateRebalance(
        uint16[4] calldata preWeightsBps,
        uint16[4] calldata postWeightsBps,
        MarketState calldata s
    ) external view returns (bool ok, bytes4 reason) {
        Config memory c = _config;

        // 1. Weights must sum to 10000.
        if (_sum(postWeightsBps) != _BPS) {
            return (false, WeightsSumNot10000.selector);
        }

        // 2. Per-bucket weight caps.
        for (uint8 i = 0; i < 4; i++) {
            if (postWeightsBps[i] > c.maxWeightBps[i]) {
                return (false, WeightExceedsCap.selector);
            }
        }

        // 3. Minimum idle buffer after rebalance.
        if (postWeightsBps[_IDLE] < c.minIdleBps) {
            return (false, IdleBufferTooLow.selector);
        }

        // 4. Minimum instant liquidity (IDLE + Aave-withdrawable).
        //    Aave-withdrawable expressed as fraction of TVL.
        uint256 aaveFractionBps = s.totalAssets > 0
            ? (s.aaveWithdrawable * _BPS) / s.totalAssets
            : 0;
        // aaveFractionBps is capped at 10000 by definition so truncation to uint16 is safe
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 instantBps = postWeightsBps[_IDLE] + _min(postWeightsBps[_AAVE], uint16(aaveFractionBps > type(uint16).max ? type(uint16).max : aaveFractionBps));
        if (instantBps < c.minInstantLiquidityBps) {
            return (false, InstantLiquidityTooLow.selector);
        }

        // 5. Rebalance frequency cap.
        if (s.lastRebalanceAt > 0 && block.timestamp - s.lastRebalanceAt < c.minRebalanceInterval) {
            return (false, RebalanceIntervalNotElapsed.selector);
        }

        // 6. Max single-rebalance move size.
        uint256 totalMoveBps = 0;
        for (uint8 i = 0; i < 4; i++) {
            totalMoveBps += postWeightsBps[i] > preWeightsBps[i]
                ? postWeightsBps[i] - preWeightsBps[i]
                : preWeightsBps[i] - postWeightsBps[i];
        }
        totalMoveBps /= 2; // each dollar moved is counted twice (out + in)
        if (totalMoveBps > c.maxRebalanceMoveBps) {
            return (false, RebalanceMoveTooLarge.selector);
        }

        // 7. USDY depeg / oracle guard.
        //    When USDY weight is increasing the caller MUST supply a non-zero DEX spot
        //    so the guard can evaluate peg health — fail closed.
        //    When oracle NAV is available and spot is non-zero, evaluate deviation.
        if (postWeightsBps[_USDY] > preWeightsBps[_USDY]) {
            if (s.usdyOracleNav > 0 && s.usdyDexSpot == 0) {
                return (false, UsdySpotRequired.selector);
            }
            if (s.usdyOracleNav > 0 && s.usdyDexSpot > 0) {
                (bool blockNewUsdy,,) = _evaluateUsdyRisk(s, c);
                if (blockNewUsdy) {
                    return (false, UsdyAllocationBlocked.selector);
                }
            }
        }

        return (true, bytes4(0));
    }

    /**
     * @notice Evaluate USDY risk given current market state.
     * @return blockNewUsdy True if new USDY allocation should be blocked.
     * @return forceDeRisk  True if USDY must be exited immediately.
     * @return riskLevel    0 = NORMAL, 1 = CAUTION, 2 = DERISK.
     */
    function evaluateUsdyRisk(MarketState calldata s)
        external
        view
        returns (bool blockNewUsdy, bool forceDeRisk, uint8 riskLevel)
    {
        return _evaluateUsdyRisk(s, _config);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _evaluateUsdyRisk(MarketState memory s, Config memory c)
        internal
        view
        returns (bool blockNewUsdy, bool forceDeRisk, uint8 riskLevel)
    {
        // Oracle staleness: past range end = invalid NAV.
        bool oracleStale = s.oracleRangeEnd > 0 && block.timestamp > s.oracleRangeEnd;
        // Secondary staleness guard.
        bool oracleAged  = s.oracleUpdatedAt > 0
            && block.timestamp - s.oracleUpdatedAt > c.oracleMaxAge;
        // Within 24h of range end = caution.
        bool oracleNearEnd = s.oracleRangeEnd > 0
            && s.oracleRangeEnd > block.timestamp
            && s.oracleRangeEnd - block.timestamp < c.oracleRangeEndBuffer;

        if (oracleStale || oracleAged) {
            return (true, true, 2); // DERISK
        }

        // Peg deviation (both nav and spot must be non-zero to compute).
        if (s.usdyOracleNav > 0 && s.usdyDexSpot > 0) {
            uint256 deviationBps;
            if (s.usdyDexSpot < s.usdyOracleNav) {
                deviationBps = (s.usdyOracleNav - s.usdyDexSpot) * _BPS / s.usdyOracleNav;
            } else {
                deviationBps = (s.usdyDexSpot - s.usdyOracleNav) * _BPS / s.usdyOracleNav;
            }

            if (deviationBps >= c.pegDeRiskBps) {
                return (true, true, 2); // DERISK
            }
            if (deviationBps >= c.pegBlockBps) {
                return (true, false, 1); // CAUTION, block new
            }
            if (deviationBps >= c.pegWarnBps || oracleNearEnd) {
                return (false, false, 1); // CAUTION, don't block
            }
        }

        if (oracleNearEnd) {
            return (false, false, 1); // CAUTION
        }

        return (false, false, 0); // NORMAL
    }

    function _sum(uint16[4] calldata w) private pure returns (uint256 s) {
        s = uint256(w[0]) + w[1] + w[2] + w[3];
    }

    function _min(uint16 a, uint16 b) private pure returns (uint16) {
        return a < b ? a : b;
    }

    function _requireValidConfig(Config calldata c) private pure {
        // minIdleBps <= minInstantLiquidityBps, and both < 10000
        if (c.minIdleBps > c.minInstantLiquidityBps) revert InvalidConfig();
        if (c.minInstantLiquidityBps >= _BPS) revert InvalidConfig();
        if (c.pegWarnBps > c.pegBlockBps) revert InvalidConfig();
        if (c.pegBlockBps > c.pegDeRiskBps) revert InvalidConfig();
    }
}
