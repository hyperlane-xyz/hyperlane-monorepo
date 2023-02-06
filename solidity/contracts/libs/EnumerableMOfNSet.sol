// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

library EnumerableMOfNSet {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;

    struct AddressSet {
        uint8 threshold;
        EnumerableSet.AddressSet addresses;
        bytes32 commitment;
    }

    // ============ Library Functions ============
    function add(AddressSet storage _set, address _value)
        internal
        returns (bytes32)
    {
        _add(_set, _value);
        return _updateCommitment(_set);
    }

    function add(AddressSet storage _set, address[] memory _values)
        internal
        returns (bytes32)
    {
        for (uint256 i = 0; i < _values.length; i++) {
            _add(_set, _values[i]);
        }
        return _updateCommitment(_set);
    }

    function remove(AddressSet storage _set, address _value)
        internal
        returns (bytes32)
    {
        _remove(_set, _value);
        return _updateCommitment(_set);
    }

    function remove(AddressSet storage _set, address[] memory _values)
        internal
        returns (bytes32)
    {
        for (uint256 i = 0; i < _values.length; i++) {
            _remove(_set, _values[i]);
        }
        return _updateCommitment(_set);
    }

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

    function values(AddressSet storage _set)
        internal
        view
        returns (address[] memory)
    {
        return _set.addresses.values();
    }

    function at(AddressSet storage _set, uint8 i)
        internal
        view
        returns (address)
    {
        return _set.addresses.at(i);
    }

    function contains(AddressSet storage _set, address _value)
        internal
        view
        returns (bool)
    {
        return _set.addresses.contains(_value);
    }

    function length(AddressSet storage _set) internal view returns (uint256) {
        return _set.addresses.length();
    }

    function matches(
        AddressSet storage _set,
        uint8 _threshold,
        address[] memory _values
    ) internal view returns (bool) {
        bytes32 _commitment = _computeCommitment(_threshold, _values);
        return _commitment == _set.commitment;
    }

    function matches(
        AddressSet storage _set,
        uint8 _threshold,
        bytes calldata _values
    ) internal view returns (bool) {
        bytes32 _commitment = keccak256(abi.encodePacked(_threshold, _values));
        return _commitment == _set.commitment;
    }

    function valuesAndThreshold(AddressSet storage _set)
        external
        view
        returns (address[] memory, uint8)
    {
        return (values(_set), _set.threshold);
    }

    // ============ Internal Functions ============
    function _add(AddressSet storage _set, address _value) private {
        require(_value != address(0), "zero address");
        require(_set.addresses.add(_value), "already added");
    }

    function _remove(AddressSet storage _set, address _value) private {
        require(_set.addresses.remove(_value), "not added");
        require(_set.addresses.length() >= _set.threshold, "reduce threshold");
    }

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

    function _computeCommitment(uint8 _threshold, address[] memory _values)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_threshold, _values));
    }
}
