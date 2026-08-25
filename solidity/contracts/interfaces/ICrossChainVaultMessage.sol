// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title ICrossChainVaultMessage
 * @notice Types and constants for cross-chain vault messages over Hyperlane.
 */
interface ICrossChainVaultMessage {
    struct Message {
        uint8 msgType;
        bytes32 recipientOrSender;
        uint256 amount;
        uint256 minAmountOut;
        uint256 deadline;
        bytes extraData;
    }
}
