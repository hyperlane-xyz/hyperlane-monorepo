// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {TypeCasts} from "../libs/TypeCasts.sol";
import {InterchainAccountRouter} from "./InterchainAccountRouter.sol";
import {CallLib} from "./libs/Call.sol";
import {InterchainAccountMirrorCalldata} from "./libs/InterchainAccountMirrorCalldata.sol";

contract InterchainAccountMirror {
    using InterchainAccountMirrorCalldata for bytes;
    using TypeCasts for address;

    address immutable owner;

    uint32 immutable destination;
    address immutable target;

    InterchainAccountRouter immutable icaRouter;

    constructor(
        address _owner,
        uint32 _destination,
        address _target,
        InterchainAccountRouter _icaRouter
    ) {
        owner = _owner;
        destination = _destination;
        target = _target;
        icaRouter = _icaRouter;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "sender not owner");
        _;
    }

    // solhint-disable-next-line no-complex-fallback
    fallback() external payable onlyOwner {
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
