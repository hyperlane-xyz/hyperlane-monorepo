// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/**
 * @title WormholeMessage
 * @notice Fixed-size payload published through Wormhole Core for a Hyperlane
 * message.
 * @dev All seven fields are static, so `abi.encode` yields one exact length and
 * `decode` needs no custom offsets. `messageId` commits to the full Hyperlane
 * message; the explicit routing fields let a destination authenticate and route
 * a VAA before the Hyperlane message is available.
 */
library WormholeMessage {
    // ============ Errors ============

    error InvalidPayloadLength();
    error InvalidPayloadMagic();
    error InvalidPayloadVersion();

    // ============ Constants ============

    bytes4 internal constant MAGIC = bytes4(keccak256("HYPERLANE_WORMHOLE"));
    uint8 internal constant VERSION = 1;
    uint256 internal constant ENCODED_LENGTH = 32 * 7;

    // ============ Types ============

    struct Message {
        bytes4 magic;
        uint8 version;
        uint32 originDomain;
        uint32 destinationDomain;
        bytes32 destinationRouter;
        bytes32 messageId;
        uint32 nonce;
    }

    // ============ Functions ============

    function encode(
        uint32 originDomain,
        uint32 destinationDomain,
        bytes32 destinationRouter,
        bytes32 messageId,
        uint32 nonce
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                Message({
                    magic: MAGIC,
                    version: VERSION,
                    originDomain: originDomain,
                    destinationDomain: destinationDomain,
                    destinationRouter: destinationRouter,
                    messageId: messageId,
                    nonce: nonce
                })
            );
    }

    function decode(
        bytes memory payload
    ) internal pure returns (Message memory m) {
        if (payload.length != ENCODED_LENGTH) revert InvalidPayloadLength();
        m = abi.decode(payload, (Message));
        if (m.magic != MAGIC) revert InvalidPayloadMagic();
        if (m.version != VERSION) revert InvalidPayloadVersion();
    }
}
