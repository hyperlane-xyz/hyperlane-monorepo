// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title ERC-5164: Cross-Chain Execution Standard
 * @dev See https://eips.ethereum.org/EIPS/eip-5164
 */
interface IMessageDispatcher {
    /**
     * @notice Emitted when a message has successfully been dispatched to the executor chain.
     * @param messageId ID uniquely identifying the message
     * @param from Address that dispatched the message
     * @param toChainId ID of the chain receiving the message
     * @param to Address that will receive the message
     * @param data Data that was dispatched
     */
    event MessageDispatched(
        bytes32 indexed messageId,
        address indexed from,
        uint256 indexed toChainId,
        address to,
        bytes data
    );

    function dispatchMessage(
        uint256 toChainId,
        address to,
        bytes calldata data
    ) external returns (bytes32);
}
