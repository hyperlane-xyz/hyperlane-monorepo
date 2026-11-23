// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";

/**
 * @title LayerZeroPacketV1
 * @notice Validates the shape of an encoded LayerZero PacketV1 that carries a
 * fixed-length message.
 * @dev PacketV1 byte layout: [0] version, [1:9] nonce, [9:13] srcEid,
 * [13:45] sender, [45:49] dstEid, [49:81] receiver, [81:113] guid,
 * [113:] message.
 */
library LayerZeroPacketV1 {
    using PacketV1Codec for bytes;

    // `PacketV1Codec` keeps its message offset private.
    uint256 internal constant MESSAGE_OFFSET = 113;

    error InvalidLayerZeroPacketLength(uint256 length);
    error InvalidLayerZeroPacketVersion(uint8 version);

    /// @dev Accepts only the PacketV1 version and a message of exactly
    /// `expectedMessageLength` bytes; rejects any trailing data.
    function validate(
        bytes calldata packet,
        uint256 expectedMessageLength
    ) internal pure {
        if (packet.length != MESSAGE_OFFSET + expectedMessageLength) {
            revert InvalidLayerZeroPacketLength(packet.length);
        }

        uint8 version = packet.version();
        if (version != PacketV1Codec.PACKET_VERSION) {
            revert InvalidLayerZeroPacketVersion(version);
        }
    }
}
