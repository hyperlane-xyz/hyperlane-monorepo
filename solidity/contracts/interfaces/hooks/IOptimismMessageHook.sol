// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMessageHook} from "./IMessageHook.sol";

interface IOptimismMessageHook is IMessageHook {
    // ============ Events ============
    /**
     * @notice Emitted when a message is published throug the native Optimism bridges
     * @dev Used by the relayer to aid in finding the messageId
     * @param sender The sender of the message
     * @param messageId The hyperlane message ID
     */
    event OptimismMessagePublished(
        address indexed sender,
        bytes32 indexed messageId
    );
}
