// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/**
 * @title WormholeMessage
 * @notice Fixed-size payload published through Wormhole Core for a Hyperlane
 * message.
 * @dev All four fields have fixed-size types, so the ABI-encoded payload has
 * a fixed length. `messageId` commits to all Hyperlane message fields.
 */
library WormholeMessage {
    // ============ Errors ============

    error InvalidPayloadLength();
    error InvalidPayloadMagic();
    error InvalidPayloadVersion();

    // ============ Constants ============

    bytes4 internal constant MAGIC = bytes4(keccak256("HYPERLANE_WORMHOLE"));
    uint8 internal constant VERSION = 1;
    uint256 internal constant ENCODED_LENGTH = 32 * 4;

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
        return
            abi.encode(
                Message({
                    magic: MAGIC,
                    version: VERSION,
                    destinationHookIsm: destinationHookIsm,
                    messageId: messageId
                })
            );
    }

    function decode(
        bytes memory payload
    ) internal pure returns (Message memory m) {
        if (payload.length != ENCODED_LENGTH) {
            revert InvalidPayloadLength();
        }

        m = abi.decode(payload, (Message));

        if (m.magic != MAGIC) {
            revert InvalidPayloadMagic();
        }

        if (m.version != VERSION) {
            revert InvalidPayloadVersion();
        }
    }
}
