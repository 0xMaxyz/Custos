// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IRWADynamicOracle } from "../../src/interfaces/IRWADynamicOracle.sol";

/**
 * @notice Mock of Ondo's mUSD wrap/unwrap converter for unit tests. Stands in for
 *         the real Mantle mUSD (0xab57…7cF3), which hosts `wrap`/`unwrap` on the
 *         token itself and prices the USDY ↔ mUSD conversion off the RWADynamicOracle.
 *
 * Conversion math (matches the real contract, verified on-chain):
 *   wrap(usdyAmount):  pulls USDY (caller must approve), mints mUSD = usdyAmount × NAV / 1e18.
 *   unwrap(musdAmount): burns the caller's mUSD, returns USDY = musdAmount × 1e18 / NAV.
 * Both tokens are 18-dec; mUSD is $1-pegged so its face value equals NAV-priced USDY.
 *
 * Minimal self-contained ERC20 (mint on wrap, burn on unwrap). Holds the USDY pulled
 * during wrap as backing for later unwraps.
 */
contract MockMusd {
    using SafeERC20 for IERC20;

    string public constant name = "Mock mUSD";
    string public constant symbol = "mUSD";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable usdy;
    address public immutable oracle;

    constructor(address _usdy, address _oracle) {
        usdy = _usdy;
        oracle = _oracle;
    }

    // ── Converter ──────────────────────────────────────────────────────────────

    function wrap(uint256 usdyAmount) external {
        IERC20(usdy).safeTransferFrom(msg.sender, address(this), usdyAmount);
        uint256 nav = IRWADynamicOracle(oracle).getPrice();
        uint256 musdOut = (usdyAmount * nav) / 1e18;
        _mint(msg.sender, musdOut);
    }

    function unwrap(uint256 musdAmount) external {
        _burn(msg.sender, musdAmount);
        uint256 nav = IRWADynamicOracle(oracle).getPrice();
        uint256 usdyOut = (musdAmount * 1e18) / nav;
        IERC20(usdy).safeTransfer(msg.sender, usdyOut);
    }

    // ── Minimal ERC20 ────────────────────────────────────────────────────────────

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function forceApprove(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function _mint(address to, uint256 amt) internal {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function _burn(address from, uint256 amt) internal {
        balanceOf[from] -= amt;
        totalSupply -= amt;
    }
}
