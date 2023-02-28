// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

contract StaticMOfNAddressSet {
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
    constructor(address[] memory _values, uint8 threshold) {
        require(0 < _values.length && _values.length <= 16);
        require(0 < threshold && threshold <= _values.length);
        _threshold = threshold;
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

    function values() internal view returns (address[] memory) {
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

    function valueAt(uint256 i) internal view returns (address) {
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
