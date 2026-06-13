// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Test } from "forge-std/Test.sol";
import { Custos } from "../src/Custos.sol";

contract CustosTest is Test {
    function test_MantleChainIdConstant() public pure {
        assertEq(Custos.MANTLE_CHAIN_ID, 5000);
    }
}
