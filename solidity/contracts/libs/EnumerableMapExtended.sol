// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// extends EnumerableMap with uint256 => bytes32 type
// modelled after https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.8.0/contracts/utils/structs/EnumerableMap.sol
library EnumerableMapExtended {
    using EnumerableMap for EnumerableMap.Bytes32ToBytes32Map;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    struct UintToBytes32Map {
        EnumerableMap.Bytes32ToBytes32Map _inner;
    }

    // ============ Library Functions ============
    function keys(UintToBytes32Map storage map)
        internal
        view
        returns (uint256[] memory _keys)
    {
        uint256 _length = map._inner.length();
        _keys = new uint256[](_length);
        for (uint256 i = 0; i < _length; i++) {
            _keys[i] = uint256(map._inner._keys.at(i));
        }
    }

    function uint32Keys(UintToBytes32Map storage map)
        internal
        view
        returns (uint32[] memory _keys)
    {
        uint256[] memory uint256keys = keys(map);
        _keys = new uint32[](uint256keys.length);
        for (uint256 i = 0; i < uint256keys.length; i++) {
            _keys[i] = uint32(uint256keys[i]);
        }
    }

    function set(
        UintToBytes32Map storage map,
        uint256 key,
        bytes32 value
    ) internal {
        map._inner.set(bytes32(key), value);
    }

    function get(UintToBytes32Map storage map, uint256 key)
        internal
        view
        returns (bytes32)
    {
        return map._inner.get(bytes32(key));
    }

    function tryGet(UintToBytes32Map storage map, uint256 key)
        internal
        view
        returns (bool, bytes32)
    {
        return map._inner.tryGet(bytes32(key));
    }

    function remove(UintToBytes32Map storage map, uint256 key)
        internal
        returns (bool)
    {
        return map._inner.remove(bytes32(key));
    }

    function contains(UintToBytes32Map storage map, uint256 key)
        internal
        view
        returns (bool)
    {
        return map._inner.contains(bytes32(key));
    }

    function length(UintToBytes32Map storage map)
        internal
        view
        returns (uint256)
    {
        return map._inner.length();
    }

    function at(UintToBytes32Map storage map, uint256 index)
        internal
        view
        returns (uint256, bytes32)
    {
        (bytes32 key, bytes32 value) = map._inner.at(index);
        return (uint256(key), value);
    }
}
