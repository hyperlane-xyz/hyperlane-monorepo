// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.17;
import {TypeCasts} from "./TypeCasts.sol";
import {EnumerableMapExtended} from "./EnumerableMapExtended.sol";

library OverridableEnumerableMap {
    struct UintToBytes32OverridableMap {
        EnumerableMapExtended.UintToBytes32Map _defaults;
        mapping(address => EnumerableMapExtended.UintToBytes32Map) _overrides;
    }

    function defaultKeys(UintToBytes32OverridableMap storage map)
        internal
        view
        returns (bytes32[] storage)
    {
        return EnumerableMapExtended.keys(map._defaults);
    }

    function setDefault(
        UintToBytes32OverridableMap storage map,
        uint256 _key,
        bytes32 _value
    ) internal {
        EnumerableMapExtended.set(map._defaults, _key, _value);
    }

    function setOverride(
        UintToBytes32OverridableMap storage map,
        address _address,
        uint256 _key,
        bytes32 _value
    ) internal {
        EnumerableMapExtended.set(map._overrides[_address], _key, _value);
    }

    function getDefault(UintToBytes32OverridableMap storage map, uint256 _key)
        internal
        view
        returns (bytes32)
    {
        return EnumerableMapExtended.get(map._defaults, _key);
    }

    function get(
        UintToBytes32OverridableMap storage map,
        address _address,
        uint256 _key
    ) internal view returns (bytes32) {
        bytes32 _override = EnumerableMapExtended.get(
            map._overrides[_address],
            _key
        );
        if (_override != bytes32(0)) {
            return _override;
        }
        return getDefault(map, _key);
    }
}
