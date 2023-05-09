// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

/**
 * @title StaticMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used
 * to verify interchain messages.
 */
abstract contract AbstractStaticMultisigIsm is AbstractMultisigIsm {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(bytes calldata)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}
