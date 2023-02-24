// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.17;
import {TypeCasts} from "./TypeCasts.sol";

library OverridableDomainMap {
    struct Bytes32DomainMap {
        mapping(uint32 => bytes32) _defaults;
        mapping(address => mapping(uint32 => bytes32)) _overrides;
    }

    function setDefault(
        Bytes32DomainMap storage map,
        uint32 _domain,
        bytes32 _value
    ) internal {
        map._defaults[_domain] = _value;
    }

    function setOverride(
        Bytes32DomainMap storage map,
        address _user,
        uint32 _domain,
        bytes32 _value
    ) internal {
        map._overrides[_user][_domain] = _value;
    }

    function getDefault(Bytes32DomainMap storage map, uint32 _domain)
        internal
        view
        returns (bytes32)
    {
        return map._defaults[_domain];
    }

    function get(
        Bytes32DomainMap storage map,
        address _user,
        uint32 _domain
    ) internal view returns (bytes32) {
        bytes32 _override = map._overrides[_user][_domain];
        if (_override != bytes32(0)) {
            return _override;
        }
        return map._defaults[_domain];
    }
}
