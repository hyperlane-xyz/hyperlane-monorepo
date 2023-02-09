// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

library EnumerableMOfNSet {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Structs ============

    struct AddressSet {
        uint8 threshold;
        EnumerableSet.AddressSet addresses;
        bytes32 commitment;
    }

    // ============ Library Functions ============

    /**
     * @notice Adds an address to the set
     * @param _set The set to add to
     * @param _value The address to add to the set
     * @return A commitment to the contents of the set
     */
    function add(AddressSet storage _set, address _value)
        internal
        returns (bytes32)
    {
        _add(_set, _value);
        return _updateCommitment(_set);
    }

    /**
     * @notice Adds one or more addresses to the set
     * @param _set The set to add to
     * @param _values The addresses to add to the set
     * @return A commitment to the contents of the set
     */
    function add(AddressSet storage _set, address[] memory _values)
        internal
        returns (bytes32)
    {
        for (uint256 i = 0; i < _values.length; i++) {
            _add(_set, _values[i]);
        }
        return _updateCommitment(_set);
    }

    /**
     * @notice Removes an address from the set
     * @param _set The set to remove from
     * @param _value The address to remove from the set
     * @return A commitment to the contents of the set
     */
    function remove(AddressSet storage _set, address _value)
        internal
        returns (bytes32)
    {
        _remove(_set, _value);
        return _updateCommitment(_set);
    }

    /**
     * @notice Removes one or more addresses from the set
     * @param _set The set to remove from
     * @param _values The addresses to remove from the set
     * @return A commitment to the contents of the set
     */
    function remove(AddressSet storage _set, address[] memory _values)
        internal
        returns (bytes32)
    {
        for (uint256 i = 0; i < _values.length; i++) {
            _remove(_set, _values[i]);
        }
        return _updateCommitment(_set);
    }

    /**
     * @notice Sets the set threshold
     * @dev Must be between (inclusive) 1 and the set size
     * @param _set The set to set the threshold on
     * @param _threshold The threshold to set to
     * @return A commitment to the contents of the set
     */
    function setThreshold(AddressSet storage _set, uint8 _threshold)
        internal
        returns (bytes32)
    {
        require(
            _threshold > 0 && _threshold <= _set.addresses.length(),
            "!range"
        );
        _set.threshold = _threshold;
        return _updateCommitment(_set);
    }

    /**
     * @notice Returns all addresses in the set
     * @param _set The set whose addresses are returned
     * @return All addresses in the set
     */
    function values(AddressSet storage _set)
        internal
        view
        returns (address[] memory)
    {
        return _set.addresses.values();
    }

    /**
     * @notice Returns the address at index `i`
     * @param _set The set to return the address from
     * @param i The index of the address to return
     * @return The address at index `i`
     */
    function at(AddressSet storage _set, uint8 i)
        internal
        view
        returns (address)
    {
        return _set.addresses.at(i);
    }

    /**
     * @notice Returns whether or not the set contains `_value`
     * @param _set The set to check membership in
     * @param _value The address being checked for set membership
     * @return Whether or not the set contains `_value`
     */
    function contains(AddressSet storage _set, address _value)
        internal
        view
        returns (bool)
    {
        return _set.addresses.contains(_value);
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function length(AddressSet storage _set) internal view returns (uint256) {
        return _set.addresses.length();
    }

    /*
    function matches(
        AddressSet storage _set,
        uint8 _threshold,
        address[] memory _values
    ) internal view returns (bool) {
        bytes32 _commitment = _computeCommitment(_threshold, _values);
        return _commitment == _set.commitment;
    }
    */

    /**
     * @notice Returns whether or two sets are identical
     * @param _set One of the two sets to check for equality
     * @param _threshold The threshold of the second set
     * @param _values The addresses in the second set
     * @return Whether or not the two sets are identical
     */
    function matches(
        AddressSet storage _set,
        uint8 _threshold,
        bytes calldata _values
    ) internal view returns (bool) {
        bytes32 _commitment = keccak256(abi.encodePacked(_threshold, _values));
        return _commitment == _set.commitment;
    }

    /**
     * @notice Returns all addresses in the set and its threshold
     * @param _set The set whose addresses and threshold are returned
     * @return All addresses in the set and its threshold
     */
    function valuesAndThreshold(AddressSet storage _set)
        internal
        view
        returns (address[] memory, uint8)
    {
        return (values(_set), _set.threshold);
    }

    // ============ Internal Functions ============

    /**
     * @notice Adds an address to the set without updating the commitment
     * @param _set The set to add to
     * @param _value The address to add to the set
     */
    function _add(AddressSet storage _set, address _value) private {
        require(_value != address(0), "zero address");
        require(_set.addresses.add(_value), "contained");
    }

    /**
     * @notice Removes an address from the set without updating the commitment
     * @param _set The set to add to
     * @param _value The address to remove from the set
     */
    function _remove(AddressSet storage _set, address _value) private {
        require(_set.addresses.remove(_value), "!contained");
        require(_set.addresses.length() >= _set.threshold, "reduce threshold");
    }

    /**
     * @notice Updates the set commitment to match its content
     * @param _set The set whose commitment should be updated
     * @return The updated commitment
     */
    function _updateCommitment(AddressSet storage _set)
        private
        returns (bytes32)
    {
        bytes32 _commitment = _computeCommitment(
            _set.threshold,
            _set.addresses.values()
        );
        _set.commitment = _commitment;
        return _commitment;
    }

    /**
     * @notice Computes the commitment to the contents of a set
     * @param _threshold The set threshold
     * @param _values The set values
     * @return The commitment to the contents of the set
     */
    function _computeCommitment(uint8 _threshold, address[] memory _values)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_threshold, _values));
    }
}
