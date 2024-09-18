// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {StaticAggregationIsm} from "./StaticAggregationIsm.sol";
import {StaticThresholdAddressSetFactory} from "../../libs/StaticAddressSetFactory.sol";
import {PackageVersioned} from "contracts/PackageVersioned.sol";

contract StaticAggregationIsmFactory is
    StaticThresholdAddressSetFactory,
    PackageVersioned
{
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new StaticAggregationIsm());
    }
}
