// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {StaticAggregationHook} from "./StaticAggregationHook.sol";
import {StaticNAddressSetFactory} from "../../libs/StaticNAddressSetFactory.sol";

contract StaticAggregationHookFactory is StaticNAddressSetFactory {
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new StaticAggregationHook());
    }
}
