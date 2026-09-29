// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {BytesParsing} from "wormhole-sdk/libraries/BytesParsing.sol";

/**
 * @title WormholeMessage
 * @notice Fixed-size payload published through Wormhole Core for a Hyperlane
 * message.
 */
library WormholeMessage {
    using BytesParsing for bytes;

    // ============ Errors ============

    error InvalidPayloadLength();
    error InvalidPayloadMagic();
    error InvalidPayloadVersion();

    // ============ Constants ============

    bytes4 internal constant MAGIC = bytes4(keccak256("HYPERLANE_WORMHOLE"));
    uint8 internal constant VERSION = 1;
    uint256 internal constant ENCODED_LENGTH = 4 + 1 + 32 + 32;

    // ============ Types ============

    struct Message {
        bytes4 magic;
        uint8 version;
        bytes32 destinationHookIsm;
        bytes32 messageId;
    }

    // ============ Functions ============

    function encode(
        bytes32 destinationHookIsm,
        bytes32 messageId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(MAGIC, VERSION, destinationHookIsm, messageId);
    }

    function decode(
        bytes memory payload
    ) internal pure returns (Message memory m) {
        if (payload.length != ENCODED_LENGTH) {
            revert InvalidPayloadLength();
        }

        uint256 offset;
        (m.magic, offset) = payload.asBytes4MemUnchecked(offset);
        (m.version, offset) = payload.asUint8MemUnchecked(offset);
        (m.destinationHookIsm, offset) = payload.asBytes32MemUnchecked(offset);
        (m.messageId, ) = payload.asBytes32MemUnchecked(offset);

        if (m.magic != MAGIC) {
            revert InvalidPayloadMagic();
        }

        if (m.version != VERSION) {
            revert InvalidPayloadVersion();
        }
    }
}
