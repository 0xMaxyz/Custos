// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Sentinel} from "../src/Sentinel.sol";

contract SentinelTest is Test {
    function test_MantleChainIdConstant() public pure {
        assertEq(Sentinel.MANTLE_CHAIN_ID, 5000);
    }
}
