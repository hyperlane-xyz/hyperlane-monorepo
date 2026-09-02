// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

library LayerZeroMessage {
    uint8 internal constant VERSION = 1;
    uint256 internal constant LENGTH = 128;

    error InvalidLayerZeroMessageLength(uint256 length);
    error InvalidLayerZeroMessageVersion(uint8 version);

    function encode(
        uint32 origin,
        uint32 destination,
        bytes32 messageId
    ) internal pure returns (bytes memory) {
        return abi.encode(VERSION, origin, destination, messageId);
    }

    function decode(
        bytes calldata payload
    )
        internal
        pure
        returns (uint32 origin, uint32 destination, bytes32 messageId)
    {
        if (payload.length != LENGTH) {
            revert InvalidLayerZeroMessageLength(payload.length);
        }
        uint8 version;
        (version, origin, destination, messageId) = abi.decode(
            payload,
            (uint8, uint32, uint32, bytes32)
        );
        if (version != VERSION) revert InvalidLayerZeroMessageVersion(version);
    }
}
