// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {AbstractAggregationIsm} from "./AbstractAggregationIsm.sol";
import {AggregationIsmMetadata} from "../libs/AggregationIsmMetadata.sol";

import {OwnableMOfNAddressSet} from "../libs/OwnableMOfNAddressSet.sol";
import {StorageMOfNAddressSet} from "../libs/StorageMOfNAddressSet.sol";

/**
 * @title StorageAggregationIsm
 * @notice Manages per-domain m-of-n Validator sets in storage that are used
 * to verify interchain messages.
 */
contract StorageAggregationIsm is
    OwnableMOfNAddressSet,
    AbstractAggregationIsm
{
    // ============ Public Storage ============
    mapping(uint32 => StorageMOfNAddressSet.AddressSet) private _sets;

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() OwnableMOfNAddressSet() {}

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
        return valuesAndThreshold(Message.origin(_message));
    }

    /**
     * @notice Returns whether an address is contained in a set.
     * @param _domain The remote domain of the set.
     * @param _value The address to test for set membership.
     * @return True if the address is contained, false otherwise.
     */
    function contains(uint32 _domain, address _value)
        public
        view
        virtual
        override
        returns (bool)
    {
        return StorageMOfNAddressSet.contains(_sets[_domain], _value);
    }

    /**
     * @notice Gets the current set
     * @param _domain The remote domain of the set.
     * @return The addresses of the set.
     */
    function values(uint32 _domain)
        public
        view
        virtual
        override
        returns (address[] memory)
    {
        return StorageMOfNAddressSet.values(_sets[_domain]);
    }

    /**
     * @notice Gets the current threshold
     * @param _domain The remote domain of the set.
     * @return The threshold of the set.
     */
    function threshold(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint8)
    {
        return StorageMOfNAddressSet.threshold(_sets[_domain]);
    }

    /**
     * @notice Returns the number of values contained in the set.
     * @param _domain The remote domain of the set.
     * @return The number of values contained in the set.
     */
    function length(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return StorageMOfNAddressSet.length(_sets[_domain]);
    }

    // ============ Private Functions ============

    /**
     * @notice Adds multiple values to multiple sets.
     * @dev Reverts if `_value` is already in the set.
     * @dev _values[i] are the values to add for _domains[i].
     * @param _domains The remote domains of the sets.
     * @param _values The values to add to the sets.
     */
    function _addMany(uint32[] calldata _domains, address[][] calldata _values)
        internal
        virtual
        override
    {
        require(_domains.length == _values.length);
        for (uint256 i = 0; i < _domains.length; i++) {
            StorageMOfNAddressSet.add(_sets[_domains[i]], _values[i]);
        }
    }

    /**
     * @notice Adds a value into a set.
     * @dev Reverts if `_value` is already in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to add to the set.
     */
    function _add(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.add(_sets[_domain], _value);
    }

    /**
     * @notice Removes a value from a set.
     * @dev Reverts if `_value` is not in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to remove from the set.
     */
    function _remove(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.remove(_sets[_domain], _value);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the set.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint32 _domain, uint8 _threshold)
        internal
        virtual
        override
    {
        StorageMOfNAddressSet.setThreshold(_sets[_domain], _threshold);
    }
}
