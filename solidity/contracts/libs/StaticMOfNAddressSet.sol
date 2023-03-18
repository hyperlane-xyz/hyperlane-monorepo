// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {MetaProxyFactory} from "./MetaProxyFactory.sol";

library StaticMOfNAddressSet {
    struct AddressSet {
        MetaProxyMOfNAddressSet proxy;
    }

    // ============ Library Functions ============

    /**
     * @notice Adds an address to the set
     * @param _set The set to add to
     * @param _value The address to add to the set
     */
    function add(
        AddressSet storage _set,
        address _value,
        address _implementation
    ) internal {
        address[] memory _values = new address[](1);
        _values[0] = _value;
        _add(_set, _values, _implementation);
    }

    /**
     * @notice Adds one or more addresses to the set
     * @param _set The set to add to
     * @param _values The addresses to add to the set
     */
    function add(
        AddressSet storage _set,
        address[] memory _values,
        address _implementation
    ) internal {
        _add(_set, _values, _implementation);
    }

    /**
     * @notice Removes an address from the set
     * @param _set The set to remove from
     * @param _value The address to remove from the set
     */
    function remove(
        AddressSet storage _set,
        address _value,
        address _implementation
    ) internal {
        require(contains(_set, _value), "!contained");
        (address[] memory _oldValues, uint8 _threshold) = valuesAndThreshold(
            _set
        );
        require(_threshold <= _oldValues.length - 1, "reduce threshold");
        if (_oldValues.length == 1) {
            _set.proxy = MetaProxyMOfNAddressSet(address(0));
            return;
        }
        address[] memory _newValues = new address[](_oldValues.length - 1);
        uint256 j = 0;
        for (uint256 i = 0; i < _oldValues.length; i++) {
            bool _isEqual = _oldValues[i] == _value;
            if (!_isEqual) {
                _newValues[j] = _oldValues[i];
                j += 1;
            }
        }
        _deploy(_set, _newValues, threshold(_set), _implementation);
    }

    /**
     * @notice Sets the set threshold
     * @dev Must be between (inclusive) 1 and the set size
     * @param _set The set to set the threshold on
     * @param _threshold The threshold to set to
     */
    function setThreshold(
        AddressSet storage _set,
        uint8 _threshold,
        address _implementation
    ) internal {
        require(0 < _threshold && _threshold <= length(_set), "!range");
        _deploy(_set, values(_set), _threshold, _implementation);
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
        if (!_isDeployed(_set)) {
            return new address[](0);
        }
        return _set.proxy.values();
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
        if (!_isDeployed(_set)) {
            return 0;
        }
        return values(_set).length;
    }

    /**
     * @notice Returns number of values in the set
     * @param _set The set to return the length of
     * @return The number of values in the set
     */
    function threshold(AddressSet storage _set) internal view returns (uint8) {
        if (!_isDeployed(_set)) {
            return 0;
        }
        return _set.proxy.threshold();
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
        if (!_isDeployed(_set)) {
            return (new address[](0), 0);
        }
        return _set.proxy.valuesAndThreshold();
    }

    // ============ Internal Functions ============

    function _isDeployed(AddressSet storage _set) private view returns (bool) {
        return (address(_set.proxy) != address(0));
    }

    /**
     * @notice Adds an address to the set without updating the commitment
     * @param _set The set to add to
     * @param _values The address to add to the set
     */
    function _add(
        AddressSet storage _set,
        address[] memory _values,
        address _implementation
    ) private {
        if (!_isDeployed(_set)) {
            for (uint256 j = 0; j < _values.length; j++) {
                require(_values[j] != address(0), "zero address");
            }
            _deploy(_set, _values, 0, _implementation);
        } else {
            (address[] memory _oldValues, uint8 _threshold) = _set
                .proxy
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
            _deploy(_set, _newValues, _threshold, _implementation);
        }
    }

    function _deploy(
        AddressSet storage _set,
        address[] memory _values,
        uint8 _threshold,
        address _implementation
    ) private {
        _set.proxy = MetaProxyMOfNAddressSet(
            MetaProxyFactory.fromBytes(
                _implementation,
                abi.encode(_values, _threshold)
            )
        );
    }
}

contract MetaProxyMOfNAddressSet {
    /// @notice Returns the metadata of this (MetaProxy) contract.
    /// Only relevant with contracts created via the MetaProxy standard.
    /// @dev This function is aimed to to be invoked via a call.
    function valuesAndThreshold()
        external
        pure
        returns (address[] memory, uint8)
    {
        assembly {
            let posOfMetadataSize := sub(calldatasize(), 32)
            let size := calldataload(posOfMetadataSize)
            let dataPtr := sub(posOfMetadataSize, size)
            calldatacopy(0, dataPtr, size)
            return(0, size)
        }
    }

    function threshold() external pure returns (uint8) {
        (, uint8 _threshold) = _valuesAndThreshold();
        return _threshold;
    }

    function values() external pure returns (address[] memory) {
        (address[] memory _values, ) = _valuesAndThreshold();
        return _values;
    }

    function _valuesAndThreshold()
        internal
        pure
        returns (address[] memory, uint8)
    {
        bytes memory data;
        assembly {
            let posOfMetadataSize := sub(calldatasize(), 32)
            let size := calldataload(posOfMetadataSize)
            let dataPtr := sub(posOfMetadataSize, size)
            data := mload(64)
            // increment free memory pointer by metadata size + 32 bytes (length)
            mstore(64, add(data, add(size, 32)))
            mstore(data, size)
            let memPtr := add(data, 32)
            calldatacopy(memPtr, dataPtr, size)
        }
        return abi.decode(data, (address[], uint8));
    }
}
