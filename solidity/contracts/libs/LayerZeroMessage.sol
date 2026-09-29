// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {CalldataBytesLib} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/CalldataBytesLib.sol";

/**
 * @title LayerZeroMessage
 * @notice Fixed-size authorization payload sent through LayerZero for a
 * Hyperlane message.
 */
library LayerZeroMessage {
    using CalldataBytesLib for bytes;

    uint8 internal constant VERSION = 1;
    uint256 private constant VERSION_OFFSET = 0;
    uint256 private constant ORIGIN_OFFSET = 1;
    uint256 private constant DESTINATION_OFFSET = 5;
    uint256 private constant MESSAGE_ID_OFFSET = 9;
    uint256 internal constant LENGTH = MESSAGE_ID_OFFSET + 32;

    error InvalidLayerZeroMessageLength(uint256 length);
    error InvalidLayerZeroMessageVersion(uint8 version);

    struct Message {
        uint8 version;
        uint32 origin;
        uint32 destination;
        bytes32 messageId;
    }

    function encode(
        uint32 origin,
        uint32 destination,
        bytes32 messageId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, origin, destination, messageId);
    }

    function decode(
        bytes calldata payload
    ) internal pure returns (Message memory m) {
        if (payload.length != LENGTH) {
            revert InvalidLayerZeroMessageLength(payload.length);
        }

        m.version = payload.toU8(VERSION_OFFSET);
        m.origin = payload.toU32(ORIGIN_OFFSET);
        m.destination = payload.toU32(DESTINATION_OFFSET);
        m.messageId = payload.toB32(MESSAGE_ID_OFFSET);

        if (m.version != VERSION) {
            revert InvalidLayerZeroMessageVersion(m.version);
        }
    }
}
