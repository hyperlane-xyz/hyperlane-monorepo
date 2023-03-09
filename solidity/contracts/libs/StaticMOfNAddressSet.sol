// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

library StaticMOfNAddressSet {
    struct AddressSet {
        SingleStaticMOfNAddressSet implementation;
    }

    // ============ Library Functions ============

    /**
     * @notice Adds an address to the set
     * @param _set The set to add to
     * @param _value The address to add to the set
     */
    function add(AddressSet storage _set, address _value) internal {
        address[] memory _values = new address[](1);
        _values[0] = _value;
        _add(_set, _values);
    }

    /**
     * @notice Adds one or more addresses to the set
     * @param _set The set to add to
     * @param _values The addresses to add to the set
     */
    function add(AddressSet storage _set, address[] memory _values) internal {
        _add(_set, _values);
    }

    /**
     * @notice Removes an address from the set
     * @param _set The set to remove from
     * @param _value The address to remove from the set
     */
    function remove(AddressSet storage _set, address _value) internal {
        address[] memory _values = new address[](1);
        _values[0] = _value;
        _remove(_set, _values);
    }

    /**
     * @notice Removes one or more addresses from the set
     * @param _set The set to remove from
     * @param _values The addresses to remove from the set
     */
    function remove(AddressSet storage _set, address[] memory _values)
        internal
    {
        _remove(_set, _values);
    }

    /**
     * @notice Sets the set threshold
     * @dev Must be between (inclusive) 1 and the set size
     * @param _set The set to set the threshold on
     * @param _threshold The threshold to set to
     */
    function setThreshold(AddressSet storage _set, uint8 _threshold) internal {
        require(_threshold > 0 && _threshold <= length(_set), "!range");
        _deploy(_set, values(_set), _threshold);
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
        return _set.implementation.values();
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
        return _set.implementation.valueAt(i);
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
        address[] memory _values = values(_set);
        for (uint256 i = 0; i < _values.length; i++) {
            if (_value == _values[i]) return true;
        }
        return false;
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function length(AddressSet storage _set) internal view returns (uint256) {
        return values(_set).length;
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function threshold(AddressSet storage _set) internal view returns (uint8) {
        return _set.implementation.threshold();
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
        return _set.implementation.valuesAndThreshold();
    }

    // ============ Internal Functions ============

    /**
     * @notice Adds an address to the set without updating the commitment
     * @param _set The set to add to
     * @param _values The address to add to the set
     */
    function _add(AddressSet storage _set, address[] memory _values) private {
        (address[] memory _oldValues, uint8 _threshold) = _set
            .implementation
            .valuesAndThreshold();
        address[] memory _newValues = new address[](
            _oldValues.length + _values.length
        );

        for (uint256 i = 0; i < _oldValues.length; i++) {
            _newValues[i] = _oldValues[i];
            for (uint256 j = 0; j < _values.length; j++) {
                require(_oldValues[i] != _values[j], "contained");
            }
        }
        for (uint256 j = 0; j < _values.length; j++) {
            require(_values[j] != address(0), "zero address");
            _newValues[j + _oldValues.length] = _values[j];
        }
        _deploy(_set, _newValues, _threshold);
    }

    /**
     * @notice Removes an address from the set without updating the commitment
     * @param _set The set to add to
     * @param _values The addresses to remove from the set
     */
    function _remove(AddressSet storage _set, address[] memory _values)
        private
    {
        (address[] memory _oldValues, uint8 _threshold) = _set
            .implementation
            .valuesAndThreshold();
        require(_oldValues.length >= _threshold, "reduce threshold");
        address[] memory _newValues = new address[](
            _oldValues.length + _values.length - 1
        );

        // TODO: I don't trust this code entirely
        uint256 _contained = 0;
        for (uint256 i = 0; i < _oldValues.length; i++) {
            _newValues[i - _contained] = _oldValues[i];
            for (uint256 j = 0; j < _values.length; j++) {
                if (_oldValues[i] == _values[j]) {
                    _contained += 1;
                }
            }
        }
        _deploy(_set, _newValues, _threshold);
    }

    function _deploy(
        AddressSet storage _set,
        address[] memory _values,
        uint8 _threshold
    ) private {
        _set.implementation = new SingleStaticMOfNAddressSet(
            _values,
            _threshold
        );
    }
}

contract SingleStaticMOfNAddressSet {
    uint8 internal immutable _threshold;
    uint8 internal immutable _numValues;
    address private immutable _value0;
    address private immutable _value1;
    address private immutable _value2;
    address private immutable _value3;
    address private immutable _value4;
    address private immutable _value5;
    address private immutable _value6;
    address private immutable _value7;
    address private immutable _value8;
    address private immutable _value9;
    address private immutable _value10;
    address private immutable _value11;
    address private immutable _value12;
    address private immutable _value13;
    address private immutable _value14;
    address private immutable _value15;

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(address[] memory _values, uint8 tthreshold) {
        require(0 < _values.length && _values.length <= 16);
        require(0 < tthreshold && tthreshold <= _values.length);
        _threshold = tthreshold;
        _numValues = uint8(_values.length);
        _value0 = _numValues > 0 ? _values[0] : address(0);
        _value1 = _numValues > 1 ? _values[1] : address(0);
        _value2 = _numValues > 2 ? _values[2] : address(0);
        _value3 = _numValues > 3 ? _values[3] : address(0);
        _value4 = _numValues > 4 ? _values[4] : address(0);
        _value5 = _numValues > 5 ? _values[5] : address(0);
        _value6 = _numValues > 6 ? _values[6] : address(0);
        _value7 = _numValues > 7 ? _values[7] : address(0);
        _value8 = _numValues > 8 ? _values[8] : address(0);
        _value9 = _numValues > 9 ? _values[9] : address(0);
        _value10 = _numValues > 10 ? _values[10] : address(0);
        _value11 = _numValues > 11 ? _values[11] : address(0);
        _value12 = _numValues > 12 ? _values[12] : address(0);
        _value13 = _numValues > 13 ? _values[13] : address(0);
        _value14 = _numValues > 14 ? _values[14] : address(0);
        _value15 = _numValues > 15 ? _values[15] : address(0);
    }

    // ============ internal Functions ============
    function valuesAndThreshold()
        public
        view
        returns (address[] memory, uint8)
    {
        return (values(), _threshold);
    }

    function threshold() public view returns (uint8) {
        return _threshold;
    }

    function values() public view returns (address[] memory) {
        address[] memory _values = new address[](_numValues);

        // prettier-ignore
        {
            if (_numValues > 0) { _values[0] = _value0; } else { return _values; }
            if (_numValues > 1) { _values[1] = _value1; } else { return _values; }
            if (_numValues > 2) { _values[2] = _value2; } else { return _values; }
            if (_numValues > 3) { _values[3] = _value3; } else { return _values; }
            if (_numValues > 4) { _values[4] = _value4; } else { return _values; }
            if (_numValues > 5) { _values[5] = _value5; } else { return _values; }
            if (_numValues > 6) { _values[6] = _value6; } else { return _values; }
            if (_numValues > 7) { _values[7] = _value7; } else { return _values; }
            if (_numValues > 8) { _values[8] = _value8; } else { return _values; }
            if (_numValues > 9) { _values[9] = _value9; } else { return _values; }
            if (_numValues > 10) { _values[10] = _value10; } else { return _values; }
            if (_numValues > 11) { _values[11] = _value11; } else { return _values; }
            if (_numValues > 12) { _values[12] = _value12; } else { return _values; }
            if (_numValues > 13) { _values[13] = _value13; } else { return _values; }
            if (_numValues > 14) { _values[14] = _value14; } else { return _values; }
            if (_numValues > 15) { _values[15] = _value15; } else { return _values; }
        }
        return _values;
    }

    function valueAt(uint256 i) public view returns (address) {
        if (i < 8) {
            if (i < 4) {
                if (i < 2) {
                    return i == 0 ? _value0 : _value1;
                } else {
                    return i == 2 ? _value2 : _value3;
                }
            } else {
                if (i < 6) {
                    return i == 4 ? _value4 : _value5;
                } else {
                    return i == 6 ? _value6 : _value7;
                }
            }
        } else {
            if (i < 12) {
                if (i < 10) {
                    return i == 8 ? _value8 : _value9;
                } else {
                    return i == 10 ? _value10 : _value11;
                }
            } else {
                if (i < 14) {
                    return i == 12 ? _value12 : _value13;
                } else {
                    return i == 14 ? _value14 : _value15;
                }
            }
        }
    }
}
