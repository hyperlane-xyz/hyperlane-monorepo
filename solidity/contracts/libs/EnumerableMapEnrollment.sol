// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ External Imports ============
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
// ============ Internal Imports ============
import {TypeCasts} from "./TypeCasts.sol";

enum EnrollmentStatus {
    UNENROLLED,
    ENROLLED,
    PENDING_UNENROLLMENT
}

struct Enrollment {
    EnrollmentStatus status;
    uint248 unenrollmentStartBlock;
}

// extends EnumerableMap with address => bytes32 type
// modelled after https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.8.0/contracts/utils/structs/EnumerableMap.sol
library EnumerableMapEnrollment {
    using EnumerableMap for EnumerableMap.Bytes32ToBytes32Map;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    struct AddressToEnrollmentMap {
        EnumerableMap.Bytes32ToBytes32Map _inner;
    }

    // ============ Library Functions ============

    function encode(
        Enrollment memory enrollment
    ) public pure returns (bytes32) {
        return
            bytes32(
                abi.encodePacked(
                    uint8(enrollment.status),
                    enrollment.unenrollmentStartBlock
                )
            );
    }

    function decode(bytes32 encoded) public pure returns (Enrollment memory) {
        uint8 status = uint8(encoded[0]);
        uint248 unenrollmentStartBlock = uint248(uint256((encoded << 8) >> 8));
        return Enrollment(EnrollmentStatus(status), unenrollmentStartBlock);
    }

    function keys(
        AddressToEnrollmentMap storage map
    ) internal view returns (address[] memory _keys) {
        uint256 _length = map._inner.length();
        _keys = new address[](_length);
        for (uint256 i = 0; i < _length; i++) {
            _keys[i] = address(uint160(uint256(map._inner._keys.at(i))));
        }
    }

    function set(
        AddressToEnrollmentMap storage map,
        address key,
        Enrollment memory value
    ) internal returns (bool) {
        return map._inner.set(key.addressToBytes32(), encode(value));
    }

    function get(
        AddressToEnrollmentMap storage map,
        address key
    ) internal view returns (Enrollment memory) {
        return decode(map._inner.get(key.addressToBytes32()));
    }

    function tryGet(
        AddressToEnrollmentMap storage map,
        address key
    ) internal view returns (bool, Enrollment memory) {
        (bool success, bytes32 value) = map._inner.tryGet(
            key.addressToBytes32()
        );
        return (success, decode(value));
    }

    function remove(
        AddressToEnrollmentMap storage map,
        address key
    ) internal returns (bool) {
        return map._inner.remove(key.addressToBytes32());
    }

    function contains(
        AddressToEnrollmentMap storage map,
        address key
    ) internal view returns (bool) {
        return map._inner.contains(key.addressToBytes32());
    }

    function length(
        AddressToEnrollmentMap storage map
    ) internal view returns (uint256) {
        return map._inner.length();
    }

    function at(
        AddressToEnrollmentMap storage map,
        uint256 index
    ) internal view returns (uint256, Enrollment memory) {
        (bytes32 key, bytes32 value) = map._inner.at(index);
        return (uint256(key), decode(value));
    }
}
