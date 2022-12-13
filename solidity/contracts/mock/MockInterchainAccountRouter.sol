// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {InterchainAccountRouter} from "../middleware/InterchainAccountRouter.sol";
import {OwnableMulticall, Call} from "../OwnableMulticall.sol";

/*
 * @title The Hello World App
 * @dev You can use this simple app as a starting point for your own application.
 */
contract MockInterchainAccountRouter is InterchainAccountRouter {
    struct PendingCall {
        uint32 originDomain;
        bytes senderAndCalls;
    }

    uint32 public originDomain;

    mapping(uint256 => PendingCall) pendingCalls;
    uint256 totalCalls = 0;
    uint256 callsProcessed = 0;

    constructor(uint32 _originDomain) {
        originDomain = _originDomain;
        implementation = address(new OwnableMulticall());
    }

    function _dispatch(uint32, bytes memory _messageBody)
        internal
        override
        returns (bytes32)
    {
        pendingCalls[totalCalls] = PendingCall(originDomain, _messageBody);
        totalCalls += 1;
        return keccak256(abi.encodePacked(totalCalls));
    }

    function processNextPendingCall() public {
        PendingCall memory pendingCall = pendingCalls[callsProcessed];
        (address sender, Call[] memory calls) = abi.decode(
            pendingCall.senderAndCalls,
            (address, Call[])
        );

        getDeployedInterchainAccount(originDomain, sender).proxyCalls(calls);

        callsProcessed += 1;
    }
}
