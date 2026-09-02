// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

library LayerZeroMetadata {
    uint256 internal constant MAX_PACKET_LENGTH = 4096;

    error InvalidLayerZeroMetadata();
    error LayerZeroPacketTooLarge(uint256 length);

    /// @dev Use with `using LayerZeroMetadata for bytes` as
    /// `metadata.decode()`.
    function decode(
        bytes calldata metadata
    ) internal pure returns (address receiveLibrary, bytes calldata packet) {
        if (metadata.length < 96) revert InvalidLayerZeroMetadata();
        bytes memory decodedPacket;
        (receiveLibrary, decodedPacket) = abi.decode(
            metadata,
            (address, bytes)
        );
        if (receiveLibrary == address(0)) revert InvalidLayerZeroMetadata();
        _validatePacketLength(decodedPacket.length);
        bytes memory canonical = abi.encode(receiveLibrary, decodedPacket);
        if (keccak256(canonical) != keccak256(metadata)) {
            revert InvalidLayerZeroMetadata();
        }
        packet = metadata[96:96 + decodedPacket.length];
    }

    function _validatePacketLength(uint256 length) private pure {
        if (length > MAX_PACKET_LENGTH) {
            revert LayerZeroPacketTooLarge(length);
        }
    }
}
