// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMessageHook} from "./IMessageHook.sol";

interface IWormholeMessageHook is IMessageHook {
    // ============ Events ============
    /**
     * @notice Emitted when a message is published to Wormhole
     * @dev Used by the relayer to aid in finding VAA
     * @param payload The wormhole message payload
     * @param nonce The wormhole nonce associated with the message
     * @param sequence The wormhole sequence associated with the message
     */
    event WormholeMessagePublished(
        bytes32 indexed payload,
        uint32 nonce,
        uint64 sequence
    );
}
