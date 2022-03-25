// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

/**
 * @title IInterchainGasPaymaster
 * @notice An interface to pay source chain native tokens to cover the gas costs
 * of proving & processing messages on destination chains.
 * @dev This is only intended for paying for messages sent via a specific
 * Outbox contract on the same source chain.
 */
interface IInterchainGasPaymaster {
    /**
     * @notice Deposits the msg.value as a payment for the proving & processing
     * of a message on its destination chain.
     * @param _leafIndex The index of the message in the Outbox merkle tree.
     */
    function payGasFor(uint256 _leafIndex) external payable;
}
