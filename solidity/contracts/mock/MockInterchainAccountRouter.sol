// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {OwnableMulticall, Call} from "../OwnableMulticall.sol";
import {IInterchainAccountRouter} from "../../interfaces/IInterchainAccountRouter.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/*
 * @title The Hello World App
 * @dev You can use this simple app as a starting point for your own application.
 */
contract MockInterchainAccountRouter is IInterchainAccountRouter {
    struct PendingCall {
        uint32 originDomain;
        address sender;
        bytes serializedCalls;
    }

    uint32 public originDomain;

    mapping(uint256 => PendingCall) pendingCalls;
    uint256 totalCalls = 0;
    uint256 callsProcessed = 0;

    bytes constant bytecode = type(OwnableMulticall).creationCode;
    bytes32 constant bytecodeHash = bytes32(keccak256(bytecode));

    event InterchainAccountCreated(
        uint32 indexed origin,
        address sender,
        address account
    );

    constructor(uint32 _originDomain) {
        originDomain = _originDomain;
    }

    function dispatch(uint32, Call[] calldata calls)
        external
        returns (uint256)
    {
        pendingCalls[totalCalls] = PendingCall(
            originDomain,
            msg.sender,
            abi.encode(calls)
        );
        totalCalls += 1;
        return totalCalls;
    }

    function getInterchainAccount(uint32 _origin, address _sender)
        public
        view
        returns (address)
    {
        return _getInterchainAccount(_salt(_origin, _sender));
    }

    function getDeployedInterchainAccount(uint32 _origin, address _sender)
        public
        returns (OwnableMulticall)
    {
        bytes32 salt = _salt(_origin, _sender);
        address interchainAccount = _getInterchainAccount(salt);
        if (!Address.isContract(interchainAccount)) {
            interchainAccount = Create2.deploy(0, salt, bytecode);
            emit InterchainAccountCreated(_origin, _sender, interchainAccount);
        }
        return OwnableMulticall(interchainAccount);
    }

    function _salt(uint32 _origin, address _sender)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(abi.encodePacked(_origin, _sender));
    }

    function _getInterchainAccount(bytes32 salt)
        internal
        view
        returns (address)
    {
        return Create2.computeAddress(salt, bytecodeHash);
    }

    function processNextPendingCall() public {
        PendingCall memory pendingCall = pendingCalls[callsProcessed];
        Call[] memory calls = abi.decode(pendingCall.serializedCalls, (Call[]));

        getDeployedInterchainAccount(originDomain, pendingCall.sender)
            .proxyCalls(calls);
    }
}
