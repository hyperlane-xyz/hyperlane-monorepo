// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

/**
 * Format of data:
 * [   0: ????] destination call data
 * [ -96:  -64] destination call value
 * [ -64:  -32] destination ICA router
 * [ -32:     ] destination ISM
 */
library InterchainAccountMirrorCalldata {
    uint32 internal constant VALUE_OFFSET = 96;
    uint32 internal constant ICA_ROUTER_OFFSET = 64;
    uint32 internal constant ISM_OFFSET = 32;

    function encode(
        bytes calldata _data,
        uint256 _value,
        bytes32 _icaRouter,
        bytes32 _ism
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_data, _value, _icaRouter, _ism);
    }

    function destinationCalldata(
        bytes calldata data
    ) internal pure returns (bytes calldata) {
        return data[:data.length - VALUE_OFFSET];
    }

    function destinationValue(
        bytes calldata data
    ) internal pure returns (uint256) {
        return uint256(bytes32(data[data.length - VALUE_OFFSET:]));
    }

    function destinationIcaRouter(
        bytes calldata data
    ) internal pure returns (bytes32) {
        return bytes32(data[data.length - ICA_ROUTER_OFFSET:]);
    }

    function destinationIsm(
        bytes calldata data
    ) internal pure returns (bytes32) {
        return bytes32(data[data.length - ISM_OFFSET:]);
    }
}
