// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {CalldataBytesLib} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/CalldataBytesLib.sol";

library LayerZeroMetadata {
    using CalldataBytesLib for bytes;

    uint256 internal constant MAX_PACKET_LENGTH = 4096;
    uint256 private constant DYNAMIC_OFFSET = 64;
    uint256 private constant PACKET_LENGTH_OFFSET = 64;
    uint256 private constant PACKET_OFFSET = 96;

    error InvalidLayerZeroMetadata();
    error LayerZeroPacketTooLarge(uint256 length);

    /// @dev Decodes canonical CCIP-read metadata containing a receive library
    /// and an encoded LayerZero packet.
    function decode(
        bytes calldata metadata
    ) internal pure returns (address receiveLibrary, bytes calldata packet) {
        if (
            metadata.length < PACKET_OFFSET ||
            metadata.toU256(32) != DYNAMIC_OFFSET ||
            metadata.toU256(0) >> 160 != 0
        ) {
            revert InvalidLayerZeroMetadata();
        }

        receiveLibrary = metadata.toAddr(12);
        if (receiveLibrary == address(0)) {
            revert InvalidLayerZeroMetadata();
        }

        uint256 packetLength = metadata.toU256(PACKET_LENGTH_OFFSET);
        _validatePacketLength(packetLength);
        uint256 paddedPacketLength = (packetLength + 31) & ~uint256(31);
        if (metadata.length != PACKET_OFFSET + paddedPacketLength) {
            revert InvalidLayerZeroMetadata();
        }

        uint256 packetEnd = PACKET_OFFSET + packetLength;
        for (uint256 i = packetEnd; i < metadata.length; ++i) {
            if (metadata[i] != 0) {
                revert InvalidLayerZeroMetadata();
            }
        }

        packet = metadata[PACKET_OFFSET:packetEnd];
    }

    function _validatePacketLength(uint256 length) private pure {
        if (length > MAX_PACKET_LENGTH) {
            revert LayerZeroPacketTooLarge(length);
        }
    }
}
