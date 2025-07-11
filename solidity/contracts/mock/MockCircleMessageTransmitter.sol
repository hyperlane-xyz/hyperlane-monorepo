// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {MockToken} from "./MockToken.sol";

contract MockCircleMessageTransmitter is IMessageTransmitter {
    mapping(bytes32 => bool) processedNonces;
    MockToken token;
    uint32 public version;

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
    ) external pure returns (bool success) {
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

    function usedNonces(bytes32 _nonceId) external view returns (uint256) {
        return processedNonces[_nonceId] ? 1 : 0;
    }

    function setVersion(uint32 _version) external {
        version = _version;
    }

    function localDomain() external view returns (uint32) {
        return 0;
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
}
