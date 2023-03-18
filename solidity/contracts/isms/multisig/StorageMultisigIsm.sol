// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {OwnableStorageMOfNAddressSet} from "../OwnableStorageMOfNAddressSet.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {MultisigIsmMetadata} from "../../libs/MultisigIsmMetadata.sol";

/**
 * @title StorageMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets in storage that are used
 * to verify interchain messages.
 */
contract StorageMultisigIsm is
    OwnableStorageMOfNAddressSet,
    AbstractMultisigIsm
{
    // ============ Public Functions ============

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(bytes calldata _message)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return valuesAndThreshold(_message);
    }
}
