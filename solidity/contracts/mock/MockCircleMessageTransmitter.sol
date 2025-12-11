// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {IMessageTransmitterV2} from "../interfaces/cctp/IMessageTransmitterV2.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {IMessageHandlerV2} from "../interfaces/cctp/IMessageHandlerV2.sol";
import {MockToken} from "./MockToken.sol";
import {TypedMemView} from "../libs/TypedMemView.sol";
import {CctpMessageV1} from "../libs/CctpMessageV1.sol";
import {CctpMessageV2} from "../libs/CctpMessageV2.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockCircleMessageTransmitter is
    IMessageTransmitter,
    IMessageTransmitterV2
{
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using CctpMessageV1 for bytes29;
    using CctpMessageV2 for bytes29;
    using TypeCasts for address;

    uint64 public nonce = 0;
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
        bytes memory message,
        bytes calldata
    ) external returns (bool success) {
        bytes29 cctpMessage = TypedMemView.ref(message, 0);

        // Extract nonce and source domain to check if message was already processed
        uint32 sourceDomain;
        bytes32 nonceId;
        if (version == 0) {
            sourceDomain = cctpMessage._sourceDomain();
            uint64 nonce = cctpMessage._nonce();
            nonceId = hashSourceAndNonce(sourceDomain, nonce);
        } else {
            sourceDomain = cctpMessage._getSourceDomain();
            bytes32 nonce = cctpMessage._getNonce();
            // For V2, use the nonce directly as the nonceId (it's already a bytes32)
            nonceId = keccak256(abi.encodePacked(sourceDomain, nonce));
        }

        require(!processedNonces[nonceId], "Message already processed");
        processedNonces[nonceId] = true;

        // Extract recipient based on version
        address recipient;
        bytes32 sender;
        bytes memory messageBody;

        if (version == 0) {
            // V1
            recipient = _bytes32ToAddress(cctpMessage._recipient());
            sender = cctpMessage._sender();
            messageBody = cctpMessage._messageBody().clone();
        } else {
            // V2
            recipient = _bytes32ToAddress(cctpMessage._getRecipient());
            sender = cctpMessage._getSender();
            messageBody = cctpMessage._getMessageBody().clone();
        }

        if (version == 0) {
            // V1: Call handleReceiveMessage
            success = IMessageHandler(recipient).handleReceiveMessage({
                sourceDomain: sourceDomain,
                sender: sender,
                messageBody: messageBody
            });
        } else {
            // V2: Call handleReceiveUnfinalizedMessage
            success = IMessageHandlerV2(recipient)
                .handleReceiveUnfinalizedMessage({
                    sourceDomain: sourceDomain,
                    sender: sender,
                    finalityThresholdExecuted: 1000,
                    messageBody: messageBody
                });
        }
    }

    function _bytes32ToAddress(bytes32 _buf) internal pure returns (address) {
        return address(uint160(uint256(_buf)));
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

    function replaceMessage(
        bytes calldata,
        bytes calldata,
        bytes calldata,
        bytes32
    ) external {
        revert("Not implemented");
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) public returns (uint64) {
        // Format a complete CCTP message for the event based on version
        bytes memory cctpMessage;
        if (version == 0) {
            cctpMessage = CctpMessageV1._formatMessage({
                _msgVersion: version,
                _msgSourceDomain: 0,
                _msgDestinationDomain: destinationDomain,
                _msgNonce: 0,
                _msgSender: address(this).addressToBytes32(),
                _msgRecipient: recipient,
                _msgDestinationCaller: bytes32(0),
                _msgRawBody: messageBody
            });
        } else {
            cctpMessage = CctpMessageV2._formatMessageForRelay({
                _version: version,
                _sourceDomain: 0,
                _destinationDomain: destinationDomain,
                _sender: address(this).addressToBytes32(),
                _recipient: recipient,
                _destinationCaller: bytes32(0),
                _minFinalityThreshold: 1000,
                _messageBody: messageBody
            });
        }
        emit MessageSent(cctpMessage);
        return 0;
    }

    function sendMessageWithCaller(
        uint32,
        bytes32,
        bytes32,
        bytes calldata message
    ) external returns (uint64) {
        return
            sendMessage({
                destinationDomain: 0,
                recipient: 0,
                messageBody: message
            });
    }

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        // V2 sendMessage: format a complete CCTP V2 message
        bytes memory cctpMessage = CctpMessageV2._formatMessageForRelay({
            _version: version,
            _sourceDomain: 0,
            _destinationDomain: destinationDomain,
            _sender: address(this).addressToBytes32(),
            _recipient: recipient,
            _destinationCaller: destinationCaller,
            _minFinalityThreshold: minFinalityThreshold,
            _messageBody: messageBody
        });
        emit MessageSent(cctpMessage);
    }
}
