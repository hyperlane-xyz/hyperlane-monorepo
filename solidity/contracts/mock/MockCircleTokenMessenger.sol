// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenMessenger, ITokenMessengerV1} from "../interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {IMessageHandlerV2} from "../interfaces/cctp/IMessageHandlerV2.sol";
import {MockToken} from "./MockToken.sol";

contract MockCircleTokenMessenger is
    ITokenMessengerV1,
    ITokenMessengerV2,
    IMessageHandler,
    IMessageHandlerV2
{
    uint64 public nextNonce = 0;
    MockToken token;
    uint32 public version;

    constructor(MockToken _token) {
        token = _token;
    }

    function depositForBurn(
        uint256 _amount,
        uint32,
        bytes32,
        address _burnToken
    ) public returns (uint64 _nonce) {
        _nonce = nextNonce;
        nextNonce += 1;
        require(address(token) == _burnToken);
        token.transferFrom({
            from: msg.sender,
            to: address(this),
            amount: _amount
        });
        token.burn(_amount);
    }

    function depositForBurnWithCaller(
        uint256 _amount,
        uint32,
        bytes32,
        address _burnToken,
        bytes32
    ) external returns (uint64 _nonce) {
        depositForBurn(_amount, 0, 0, _burnToken);
    }

    function messageBodyVersion() external override returns (uint32) {
        return version;
    }

    function setVersion(uint32 _version) external {
        version = _version;
    }

    function depositForBurn(
        uint256 _amount,
        uint32,
        bytes32,
        address _burnToken,
        bytes32,
        uint256,
        uint32
    ) external {
        depositForBurn(_amount, 0, 0, _burnToken);
    }

    // V1 handler
    function handleReceiveMessage(
        uint32,
        bytes32,
        bytes calldata
    ) external pure override returns (bool) {
        return true;
    }

    // V2 handlers
    function handleReceiveFinalizedMessage(
        uint32,
        bytes32,
        uint32,
        bytes calldata
    ) external pure override returns (bool) {
        return true;
    }

    function handleReceiveUnfinalizedMessage(
        uint32,
        bytes32,
        uint32,
        bytes calldata
    ) external pure override returns (bool) {
        return true;
    }
}
