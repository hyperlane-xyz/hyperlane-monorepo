// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {StaticAggregationIsm} from "./StaticAggregationIsm.sol";
import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";

contract StaticAggregationIsmFactory is StaticMOfNAddressSetFactory {
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new StaticAggregationIsm());
    }
}
