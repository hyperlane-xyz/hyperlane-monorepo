// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {StaticAggregationIsm} from "./StaticAggregationIsm.sol";
import {MetaProxyFactory} from "../../libs/MetaProxyFactory.sol";

contract StaticAggregationIsmFactory {
    // ============ Immutables ============
    address private immutable _implementation;

    // ============ Constructor ============

    constructor() {
        _implementation = address(new StaticAggregationIsm());
    }

    function deploy(address[] memory _validators, uint8 _threshold)
        external
        returns (StaticAggregationIsm)
    {
        return
            StaticAggregationIsm(
                MetaProxyFactory.fromBytes(
                    _implementation,
                    abi.encode(_validators, _threshold)
                )
            );
    }
}
