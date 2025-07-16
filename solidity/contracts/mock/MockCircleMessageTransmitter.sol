// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {IMessageTransmitterV2} from "../interfaces/cctp/IMessageTransmitterV2.sol";
import {MockToken} from "./MockToken.sol";

contract MockCircleMessageTransmitter is
    IMessageTransmitter,
    IMessageTransmitterV2
{
    mapping(bytes32 => bool) processedNonces;
    MockToken token;
    uint32 public override version;
    uint32 public override localDomain = 0;

    constructor(MockToken _token) {
        token = _token;
    }

    function nextAvailableNonce() external view returns (uint64) {
        return 0;
    }

    function signatureThreshold() external view returns (uint256) {
        return 1;
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

    function replaceMessage(
        bytes calldata,
        bytes calldata,
        bytes calldata,
        bytes32
    ) external {
        revert("Not implemented");
    }

    function sendMessage(
        uint32,
        bytes32,
        bytes calldata message
    ) public returns (uint64) {
        emit MessageSent(message);
        return 0;
    }

    function sendMessageWithCaller(
        uint32,
        bytes32,
        bytes32,
        bytes calldata message
    ) external returns (uint64) {
        return sendMessage(0, 0, message);
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32,
        uint32,
        bytes calldata messageBody
    ) external {
        sendMessage(destinationDomain, recipient, messageBody);
    }
}
