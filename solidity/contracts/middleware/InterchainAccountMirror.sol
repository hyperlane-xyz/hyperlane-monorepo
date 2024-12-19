// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {TypeCasts} from "../libs/TypeCasts.sol";
import {InterchainAccountRouter} from "./InterchainAccountRouter.sol";
import {CallLib} from "./libs/Call.sol";
import {InterchainAccountMirrorCalldata} from "./libs/InterchainAccountMirrorCalldata.sol";

contract InterchainAccountMirror {
    using InterchainAccountMirrorCalldata for bytes;

    InterchainAccountRouter immutable icaRouter;

    uint32 immutable destination;
    bytes32 immutable target;

    address immutable owner;

    constructor(
        InterchainAccountRouter _icaRouter,
        uint32 _destination,
        bytes32 _target,
        address _owner
    ) {
        icaRouter = _icaRouter;
        destination = _destination;
        target = _target;
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "InterchainAccountMirror: only owner");
        _;
    }

    // solhint-disable-next-line no-complex-fallback
    fallback() external payable onlyOwner {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({
            to: target,
            value: msg.data.destinationValue(),
            data: msg.data.destinationCalldata()
        });
        icaRouter.callRemoteWithOverrides{value: msg.value}(
            destination,
            msg.data.destinationIcaRouter(),
            msg.data.destinationIsm(),
            calls
        );
    }
}
