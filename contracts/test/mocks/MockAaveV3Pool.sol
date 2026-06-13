// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAaveV3Pool, ReserveData } from "../../src/interfaces/IAaveV3Pool.sol";

/**
 * @notice Minimal Aave v3 Pool mock for offline AaveV3Adapter tests. Mints/burns a
 *         1:1 aToken on supply/withdraw and exposes a settable reserve `configuration`
 *         bitmap so tests can flip the active (bit 56) / paused (bit 60) flags that
 *         AaveV3Adapter.maxWithdrawable() reads.
 *
 * The aToken is any mintable/burnable ERC-20 the test supplies; this pool must hold
 * `aToken.mint`/`burn` rights via the test's mock token (see ERC20Mock in the suites).
 */
interface IMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

contract MockAaveV3Pool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    address public immutable ATOKEN;
    uint256 private _configuration;

    // Aave v3 ReserveConfiguration bit positions.
    uint256 private constant ACTIVE_BIT = 56;
    uint256 private constant PAUSED_BIT = 60;

    constructor(address aToken) {
        ATOKEN = aToken;
        // Default: active, not paused.
        _configuration = uint256(1) << ACTIVE_BIT;
    }

    /// @notice Raw bitmap setter for arbitrary states.
    function setConfiguration(uint256 cfg) external {
        _configuration = cfg;
    }

    /// @notice Convenience: set the active / paused flags directly.
    function setFlags(bool active, bool paused) external {
        uint256 cfg = 0;
        if (active) cfg |= uint256(1) << ACTIVE_BIT;
        if (paused) cfg |= uint256(1) << PAUSED_BIT;
        _configuration = cfg;
    }

    function getReserveData(address) external view override returns (ReserveData memory rd) {
        rd.configuration = _configuration;
        rd.aTokenAddress = ATOKEN;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IMintBurn(ATOKEN).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to)
        external
        override
        returns (uint256)
    {
        IMintBurn(ATOKEN).burn(msg.sender, amount);
        IERC20(asset).safeTransfer(to, amount);
        return amount;
    }
}
