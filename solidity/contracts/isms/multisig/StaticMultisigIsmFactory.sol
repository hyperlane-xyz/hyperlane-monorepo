// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {StaticMultisigIsm} from "./StaticMultisigIsm.sol";
import {MetaProxyFactory} from "../../libs/MetaProxyFactory.sol";

contract StaticMultisigIsmFactory {
    // ============ Immutables ============
    address private immutable _implementation;

    // ============ Constructor ============

    constructor() {
        _implementation = address(new StaticMultisigIsm());
    }

    function deploy(address[] memory _validators, uint8 _threshold)
        external
        returns (StaticMultisigIsm)
    {
        return
            StaticMultisigIsm(
                MetaProxyFactory.fromBytes(
                    _implementation,
                    abi.encode(_validators, _threshold)
                )
            );
    }
}
