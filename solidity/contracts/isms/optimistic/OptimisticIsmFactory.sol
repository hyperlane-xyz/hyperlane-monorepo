// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";
import {StaticOptimisticIsm} from "./StaticOptimisticIsm.sol";

/// @dev A static deployment factory so that we can embed metadata inside of the contract in a proxy format
contract OptimisticIsmFactory is StaticMOfNAddressSetFactory {
    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        StaticOptimisticIsm newDeployment = new StaticOptimisticIsm();
        newDeployment.initialize(msg.sender);
        return address(newDeployment);
    }
}
