// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IERC20Minimal {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}
