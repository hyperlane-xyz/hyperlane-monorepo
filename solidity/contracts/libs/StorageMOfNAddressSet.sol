// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

library StorageMOfNAddressSet {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Structs ============

    struct AddressSet {
        uint8 threshold;
        EnumerableSet.AddressSet values;
    }

    // ============ Library Functions ============

    /**
     * @notice Adds an address to the set
     * @param _set The set to add to
     * @param _value The address to add to the set
     */
    function add(AddressSet storage _set, address _value) internal {
        _add(_set, _value);
    }

    /**
     * @notice Adds one or more values to the set
     * @param _set The set to add to
     * @param _values The values to add to the set
     */
    function add(AddressSet storage _set, address[] memory _values) internal {
        for (uint256 i = 0; i < _values.length; i++) {
            _add(_set, _values[i]);
        }
    }

    /**
     * @notice Removes an address from the set
     * @param _set The set to remove from
     * @param _value The address to remove from the set
     */
    function remove(AddressSet storage _set, address _value) internal {
        _remove(_set, _value);
    }

    /**
     * @notice Removes one or more values from the set
     * @param _set The set to remove from
     * @param _values The values to remove from the set
     */
    function remove(AddressSet storage _set, address[] memory _values)
        internal
    {
        for (uint256 i = 0; i < _values.length; i++) {
            _remove(_set, _values[i]);
        }
    }

    /**
     * @notice Sets the set threshold
     * @dev Must be between (inclusive) 1 and the set size
     * @param _set The set to set the threshold on
     * @param _threshold The threshold to set to
     */
    function setThreshold(AddressSet storage _set, uint8 _threshold) internal {
        require(_threshold > 0 && _threshold <= _set.values.length(), "!range");
        _set.threshold = _threshold;
    }

    /**
     * @notice Returns all values in the set
     * @param _set The set whose values are returned
     * @return All values in the set
     */
    function values(AddressSet storage _set)
        internal
        view
        returns (address[] memory)
    {
        return _set.values.values();
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
        return _set.values.at(i);
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
        return _set.values.contains(_value);
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function length(AddressSet storage _set) internal view returns (uint256) {
        return _set.values.length();
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function threshold(AddressSet storage _set) internal view returns (uint8) {
        return _set.threshold;
    }

    /**
     * @notice Returns all values in the set and its threshold
     * @param _set The set whose values and threshold are returned
     * @return All values in the set and its threshold
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
        require(_set.values.add(_value), "contained");
    }

    /**
     * @notice Removes an address from the set without updating the commitment
     * @param _set The set to add to
     * @param _value The address to remove from the set
     */
    function _remove(AddressSet storage _set, address _value) private {
        require(_set.values.remove(_value), "!contained");
        require(_set.values.length() >= _set.threshold, "reduce threshold");
    }
}
