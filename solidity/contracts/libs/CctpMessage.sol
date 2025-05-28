/*
 * Copyright (c) 2022, Circle Internet Financial Limited.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
pragma solidity >=0.8.0;

import {TypedMemView} from "./TypedMemView.sol";

// @dev CCTP Message version 1
// @dev copied from https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/messages/Message.sol
library CctpMessage {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // Indices of each field in message
    uint8 private constant SOURCE_DOMAIN_INDEX = 4;
    uint8 private constant NONCE_INDEX = 12;

    /**
     * @notice Returns formatted (packed) message with provided fields
     * @param _msgVersion the version of the message format
     * @param _msgSourceDomain Domain of home chain
     * @param _msgDestinationDomain Domain of destination chain
     * @param _msgNonce Destination-specific nonce
     * @param _msgSender Address of sender on source chain as bytes32
     * @param _msgRecipient Address of recipient on destination chain as bytes32
     * @param _msgDestinationCaller Address of caller on destination chain as bytes32
     * @param _msgRawBody Raw bytes of message body
     * @return Formatted message
     **/
    function _formatMessage(
        uint32 _msgVersion,
        uint32 _msgSourceDomain,
        uint32 _msgDestinationDomain,
        uint64 _msgNonce,
        bytes32 _msgSender,
        bytes32 _msgRecipient,
        bytes32 _msgDestinationCaller,
        bytes memory _msgRawBody
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _msgVersion,
                _msgSourceDomain,
                _msgDestinationDomain,
                _msgNonce,
                _msgSender,
                _msgRecipient,
                _msgDestinationCaller,
                _msgRawBody
            );
    }

    function _sourceDomain(bytes29 _message) internal pure returns (uint32) {
        return uint32(_message.indexUint(SOURCE_DOMAIN_INDEX, 4));
    }

    function _nonce(bytes29 _message) internal pure returns (uint64) {
        return uint64(_message.indexUint(NONCE_INDEX, 8));
    }
}
