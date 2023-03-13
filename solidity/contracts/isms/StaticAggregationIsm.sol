// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {OwnableStaticMOfNAddressSet} from "./OwnableStaticMOfNAddressSet.sol";
import {AbstractAggregationIsm} from "./AbstractAggregationIsm.sol";
import {AggregationIsmMetadata} from "../libs/AggregationIsmMetadata.sol";

/**
 * @title StaticAggregationIsm
 * @notice Manages per-domain m-of-n Validator sets in storage that are used
 * to verify interchain messages.
 */
contract StaticAggregationIsm is
    OwnableStaticMOfNAddressSet,
    AbstractAggregationIsm
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
