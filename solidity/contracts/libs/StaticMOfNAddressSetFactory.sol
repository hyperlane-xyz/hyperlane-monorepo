// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

// ============ Internal Imports ============
import {MetaProxyFactory} from "./MetaProxyFactory.sol";

abstract contract StaticMOfNAddressSetFactory {
    // ============ Immutables ============
    address private immutable _implementation;

    // ============ Constructor ============

    constructor() {
        _implementation = _deployImplementation();
    }

    function _deployImplementation() internal virtual returns (address);

    function deploy(address[] memory _values, uint8 _threshold)
        external
        returns (address)
    {
        bytes memory _metadata = abi.encode(_values, _threshold);
        bytes memory _bytecode = MetaProxyFactory.bytecode(
            _implementation,
            _metadata
        );
        bytes32 _salt = keccak256(_metadata);
        bytes32 _bytecodeHash = keccak256(_bytecode);
        address _set = Create2.computeAddress(_salt, _bytecodeHash);
        if (!Address.isContract(_set)) {
            _set = Create2.deploy(0, _salt, _bytecode);
        }
        return _set;
    }
}
