// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {MockToken} from "./MockToken.sol";

contract MockCircleMessageTransmitter is IMessageTransmitter {
    uint64 public nonce = 0;
    mapping(bytes32 => bool) processedNonces;
    MockToken token;
    uint32 public override version;
    uint32 public override localDomain = 0;

    constructor(MockToken _token) {
        token = _token;
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) public override returns (uint64) {
        emit MessageSent(messageBody);
        return ++nonce;
    }

    function sendMessageWithCaller(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes calldata messageBody
    ) external override returns (uint64) {
        return sendMessage(destinationDomain, recipient, messageBody);
    }

    function replaceMessage(
        bytes calldata originalMessage,
        bytes calldata originalAttestation,
        bytes calldata newMessageBody,
        bytes32 newDestinationCaller
    ) external override {
        revert("Not implemented");
    }

    function receiveMessage(
        bytes memory,
        bytes calldata
    ) external pure override returns (bool success) {
        success = true;
    }

    function hashSourceAndNonce(
        uint32 _source,
        uint64 _nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_source, _nonce));
    }

    function process(
        bytes32 _nonceId,
        address _recipient,
        uint256 _amount
    ) public {
        processedNonces[_nonceId] = true;
        token.mint(_recipient, _amount);
    }

    function usedNonces(
        bytes32 _nonceId
    ) external view override returns (uint256) {
        return processedNonces[_nonceId] ? 1 : 0;
    }

    function setVersion(uint32 _version) external {
        version = _version;
    }
}
