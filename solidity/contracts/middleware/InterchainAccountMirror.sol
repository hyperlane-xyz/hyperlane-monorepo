// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {TypeCasts} from "../libs/TypeCasts.sol";
import {InterchainAccountRouter} from "./InterchainAccountRouter.sol";
import {CallLib} from "./libs/Call.sol";

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

contract InterchainAccountMirror {
    using InterchainAccountMirrorCalldata for bytes;
    using TypeCasts for address;

    uint32 immutable destination;
    address immutable target;

    address immutable deployer;

    InterchainAccountRouter immutable icaRouter;

    constructor(
        uint32 _destination,
        address _target,
        InterchainAccountRouter _icaRouter
    ) {
        deployer = msg.sender;
        destination = _destination;
        target = _target;
        icaRouter = _icaRouter;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "sender not deployer");
        _;
    }

    // solhint-disable-next-line no-complex-fallback
    fallback() external payable onlyDeployer {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({
            to: target.addressToBytes32(),
            value: msg.data.destinationValue(),
            data: msg.data.destinationCalldata()
        });
        icaRouter.callRemoteWithOverrides{value: msg.value}(
            destination,
            msg.data.destinationIcaRouter().addressToBytes32(),
            msg.data.destinationIsm().addressToBytes32(),
            calls
        );
    }
}
