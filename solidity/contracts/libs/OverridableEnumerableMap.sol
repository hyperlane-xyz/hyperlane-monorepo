// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.17;
import {TypeCasts} from "./TypeCasts.sol";
import {EnumerableMapExtended} from "./EnumerableMapExtended.sol";

/*
 * @title An enumerable map that allows per-address value overrides
 */
library OverridableEnumerableMap {
    struct UintToBytes32OverridableMap {
        EnumerableMapExtended.UintToBytes32Map _defaults;
        mapping(address => EnumerableMapExtended.UintToBytes32Map) _overrides;
    }

    /**
     * @notice Returns the list of keys present in the default map
     */
    function keysDefault(UintToBytes32OverridableMap storage map)
        internal
        view
        returns (bytes32[] storage)
    {
        return EnumerableMapExtended.keys(map._defaults);
    }

    /**
     * @notice Returns true if the key is in the default map. O(1).
     */
    function containsDefault(
        UintToBytes32OverridableMap storage map,
        uint256 _key
    ) internal view returns (bool) {
        return EnumerableMapExtended.contains(map._defaults, _key);
    }

    /**
     * @notice Sets a value in the default map
     */
    function setDefault(
        UintToBytes32OverridableMap storage map,
        uint256 _key,
        bytes32 _value
    ) internal {
        EnumerableMapExtended.set(map._defaults, _key, _value);
    }

    /**
     * @notice Sets a value in the override map
     */
    function setOverride(
        UintToBytes32OverridableMap storage map,
        address _address,
        uint256 _key,
        bytes32 _value
    ) internal {
        EnumerableMapExtended.set(map._overrides[_address], _key, _value);
    }

    /**
     * @notice Gets a value from the default map
     * @dev Reverts if the key is not present
     */
    function getDefault(UintToBytes32OverridableMap storage map, uint256 _key)
        internal
        view
        returns (bytes32)
    {
        return EnumerableMapExtended.get(map._defaults, _key);
    }

    /**
     * @notice Gets a value for key, returning the overridden value if set
     * @dev Returns 0 if no values are present for key
     */
    function get(
        UintToBytes32OverridableMap storage map,
        address _address,
        uint256 _key
    ) internal view returns (bytes32) {
        EnumerableMapExtended.UintToBytes32Map storage _overrides = map
            ._overrides[_address];
        if (EnumerableMapExtended.contains(_overrides, _key)) {
            return EnumerableMapExtended.get(_overrides, _key);
        }
        if (EnumerableMapExtended.contains(map._defaults, _key)) {
            return EnumerableMapExtended.get(map._defaults, _key);
        }
        return bytes32(0);
    }
}
