// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

/**
 * Format of data:
 * [   0: ????] destination call data
 * [ -72:  -40] destination call value
 * [ -40:  -20] destination ICA router
 * [ -20:     ] destination ISM
 */
library InterchainAccountMirrorCalldata {
    function encode(
        bytes calldata _data,
        uint256 _value,
        address _icaRouter,
        address _ism
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(_data, _value, _icaRouter, _ism);
    }

    function destinationValue(
        bytes calldata data
    ) internal pure returns (uint256) {
        return uint256(bytes32(data[data.length - 72:data.length - 40]));
    }

    function destinationCalldata(
        bytes calldata data
    ) internal pure returns (bytes calldata) {
        return data[:data.length - 40];
    }

    function destinationIcaRouter(
        bytes calldata data
    ) internal pure returns (address) {
        return address(bytes20(data[data.length - 40:]));
    }

    function destinationIsm(
        bytes calldata data
    ) internal pure returns (address) {
        return address(bytes20(data[data.length - 20:]));
    }
}
