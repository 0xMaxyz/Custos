// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IRWADynamicOracle } from "../../src/interfaces/IRWADynamicOracle.sol";

/// @notice Configurable mock of Ondo's RWADynamicOracle for unit tests.
contract MockRWADynamicOracle is IRWADynamicOracle {
    uint256 public price;
    uint256 public rangeStart;
    uint256 public rangeEnd;
    bool public shouldRevert;

    constructor(uint256 _price, uint256 _rangeEnd) {
        price = _price;
        rangeStart = block.timestamp;
        rangeEnd = _rangeEnd;
    }

    function setPrice(uint256 _price) external {
        price = _price;
    }

    function setRange(uint256 start, uint256 end) external {
        rangeStart = start;
        rangeEnd = end;
    }

    function setShouldRevert(bool _r) external {
        shouldRevert = _r;
    }

    function getPrice() external view override returns (uint256) {
        if (shouldRevert) revert("MockOracle: reverted");
        return price;
    }

    function currentRange() external view override returns (uint256, uint256) {
        return (rangeStart, rangeEnd);
    }
}
