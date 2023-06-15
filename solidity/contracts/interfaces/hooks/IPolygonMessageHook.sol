// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMessageHook} from "./IMessageHook.sol";

interface IPolygonMessageHook is IMessageHook {
    // ============ Events ============
    /**
     * @notice Emitted when a message is published through the native polygon tunnel
     * @dev Used by the relayer to aid in finding the message ID
     * @param sender The sender of the message
     * @param messageId The hyperlane message ID
     */
    event PolygonMessagePublished(
        address indexed sender,
        bytes32 indexed messageId
    );
}
