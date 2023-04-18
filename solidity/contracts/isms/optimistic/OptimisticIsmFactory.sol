// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {StaticOptimisticIsm} from "./StaticOptimisticIsm.sol";
import {StaticMOfNAndKAddressSetFactory} from "../../libs/StaticMOfNAndKAddressSetFactory.sol";

contract OptimisticIsmFactory is StaticMOfNAndKAddressSetFactory {
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new StaticOptimisticIsm());
    }
}
