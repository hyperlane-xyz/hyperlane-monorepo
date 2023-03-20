// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {OwnableStorageMOfNAddressSet} from "../OwnableStorageMOfNAddressSet.sol";
import {AbstractAggregationIsm} from "./AbstractAggregationIsm.sol";
import {AggregationIsmMetadata} from "../../libs/AggregationIsmMetadata.sol";

/**
 * @title StorageAggregationIsm
 * @notice Manages per-domain m-of-n ISM sets that are used to verify
 * interchain messages.
 */
contract StorageAggregationIsm is
    OwnableStorageMOfNAddressSet,
    AbstractAggregationIsm
{
    // ============ Public Functions ============

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return isms The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function ismsAndThreshold(bytes calldata _message)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return valuesAndThreshold(_message);
    }
}
