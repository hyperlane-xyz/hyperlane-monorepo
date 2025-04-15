/*
 * Copyright 2024 Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
pragma solidity >=0.8.0;

import {TypedMemView} from "@memview-sol/contracts/TypedMemView.sol";

// @dev copied from https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/messages/v2/MessageV2.sol
// @dev We need only source domain and nonce which have the same indexes of Cctp message version 1
// @dev We are using the 'latest-solidity' branch for @memview-sol, which supports solidity version
// greater or equal than 0.8.0
library CctpMessageV2 {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // Indices of each field in message
    uint8 private constant VERSION_INDEX = 0;
    uint8 private constant SOURCE_DOMAIN_INDEX = 4;
    uint8 private constant DESTINATION_DOMAIN_INDEX = 8;
    uint8 private constant NONCE_INDEX = 12;
    uint8 private constant SENDER_INDEX = 44;
    uint8 private constant RECIPIENT_INDEX = 76;
    uint8 private constant DESTINATION_CALLER_INDEX = 108;
    uint8 private constant MIN_FINALITY_THRESHOLD_INDEX = 140;
    uint8 private constant FINALITY_THRESHOLD_EXECUTED_INDEX = 144;
    uint8 private constant MESSAGE_BODY_INDEX = 148;

    bytes32 private constant EMPTY_NONCE = bytes32(0);
    uint32 private constant EMPTY_FINALITY_THRESHOLD_EXECUTED = 0;

    function _formatMessageForRelay(
        uint32 _version,
        uint32 _sourceDomain,
        uint32 _destinationDomain,
        bytes32 _sender,
        bytes32 _recipient,
        bytes32 _destinationCaller,
        uint32 _minFinalityThreshold,
        bytes calldata _messageBody
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _version,
                _sourceDomain,
                _destinationDomain,
                EMPTY_NONCE,
                _sender,
                _recipient,
                _destinationCaller,
                _minFinalityThreshold,
                EMPTY_FINALITY_THRESHOLD_EXECUTED,
                _messageBody
            );
    }

    //
    function _getVersion(bytes29 _message) internal pure returns (uint32) {
        return uint32(_message.indexUint(VERSION_INDEX, 4));
    }

    function _getSourceDomain(bytes29 _message) internal pure returns (uint32) {
        return uint32(_message.indexUint(SOURCE_DOMAIN_INDEX, 4));
    }

    function _getDestinationDomain(
        bytes29 _message
    ) internal pure returns (uint32) {
        return uint32(_message.indexUint(DESTINATION_DOMAIN_INDEX, 4));
    }

    function _getNonce(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(NONCE_INDEX, 32);
    }

    // @dev Copied from _nonce() of Message.sol of the CCTP repo in order to support
    // CCTP v1 messages
    function _getNonceV1(bytes29 _message) internal pure returns (uint64) {
        return uint64(_message.indexUint(NONCE_INDEX, 8));
    }

    function _getSender(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(SENDER_INDEX, 32);
    }

    function _getRecipient(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(RECIPIENT_INDEX, 32);
    }

    function _getDestinationCaller(
        bytes29 _message
    ) internal pure returns (bytes32) {
        return _message.index(DESTINATION_CALLER_INDEX, 32);
    }

    function _getMinFinalityThreshold(
        bytes29 _message
    ) internal pure returns (uint32) {
        return uint32(_message.indexUint(MIN_FINALITY_THRESHOLD_INDEX, 4));
    }

    function _getFinalityThresholdExecuted(
        bytes29 _message
    ) internal pure returns (uint32) {
        return uint32(_message.indexUint(FINALITY_THRESHOLD_EXECUTED_INDEX, 4));
    }

    function _getMessageBody(bytes29 _message) internal pure returns (bytes29) {
        return
            _message.slice(
                MESSAGE_BODY_INDEX,
                _message.len() - MESSAGE_BODY_INDEX,
                0
            );
    }

    function _validateMessageFormat(bytes29 _message) internal pure {
        require(_message.isValid(), "Malformed message");
        require(
            _message.len() >= MESSAGE_BODY_INDEX,
            "Invalid message: too short"
        );
    }
}
