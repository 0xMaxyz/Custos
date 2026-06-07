// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IStrategyAdapter } from "../../src/interfaces/IStrategyAdapter.sol";

/**
 * @title MockStrategyAdapter
 * @notice Test double for IStrategyAdapter. Holds USDC directly (no yield).
 *         `yieldBps` can be set to simulate accrued yield for share-price tests.
 */
contract MockStrategyAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public immutable override underlying;

    /// Simulated extra yield on top of deposited principal (bps, 0 = no yield).
    uint16 public yieldBps;

    uint256 private _deposited;

    constructor(address _usdc) {
        usdc = _usdc;
        underlying = _usdc;
    }

    function setYieldBps(uint16 bps) external {
        yieldBps = bps;
    }

    function totalAssets() external view override returns (uint256) {
        return _deposited + (_deposited * yieldBps) / 10_000;
    }

    function maxWithdrawable() external view override returns (uint256) {
        return this.totalAssets();
    }

    function hasAssets() external view override returns (bool) {
        return IERC20(usdc).balanceOf(address(this)) > 0;
    }

    function deposit(uint256 usdcAmount, bytes calldata) external override returns (uint256) {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        _deposited += usdcAmount;
        return usdcAmount;
    }

    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata)
        external
        override
        returns (uint256)
    {
        require(usdcAmount >= minOutUsdc, "MockAdapter: below minOut");
        uint256 available = this.totalAssets();
        uint256 out = usdcAmount > available ? available : usdcAmount;
        require(out >= minOutUsdc, "MockAdapter: below minOut");
        _deposited = _deposited > out ? _deposited - out : 0;
        IERC20(usdc).safeTransfer(to, out);
        return out;
    }

    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata)
        external
        override
        returns (uint256)
    {
        uint256 out = IERC20(usdc).balanceOf(address(this));
        require(out >= minOutUsdc, "MockAdapter: below minOut");
        _deposited = 0;
        IERC20(usdc).safeTransfer(to, out);
        return out;
    }
}
