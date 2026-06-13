// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.28;

struct ReserveData {
    // slot 0
    uint256 configuration;
    // slot 1
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    // slot 2
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    // slot 3
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    // slot 4
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

interface IAaveV3Pool {
    function getReserveData(address asset) external view returns (ReserveData memory);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
