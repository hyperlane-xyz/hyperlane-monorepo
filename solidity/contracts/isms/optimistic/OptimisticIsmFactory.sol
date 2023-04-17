// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {OptimisticIsm} from "./OptimisticIsm.sol";
import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";

contract OptimisticIsmFactory is StaticMOfNAddressSetFactory {
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new OptimisticIsm());
    }
}
