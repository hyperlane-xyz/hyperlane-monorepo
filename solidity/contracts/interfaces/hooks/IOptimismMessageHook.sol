// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMessageHook} from "./IMessageHook.sol";

interface IOptimismMessageHook is IMessageHook {
    // ============ Events ============
    /**
     * @notice Emitted when a message is published throug the native Optimism bridges
     * @dev Used by the relayer to aid in finding VAA
     * @param target The wormhole message payload
     * @param sender The wormhole nonce associated with the message
     * @param messageId The wormhole sequence associated with the message
     */
    event OptimismMessagePublished(
        address indexed target,
        address indexed sender,
        bytes32 indexed messageId
    );
}
