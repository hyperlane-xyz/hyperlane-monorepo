// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IMailbox
 * @notice Interface for Hyperlane Mailbox contracts.
 */
interface IMailbox {
    event Dispatch(address indexed sender, uint32 indexed destinationDomain, bytes32 indexed recipientAddress, bytes message);
    event DispatchId(bytes32 indexed messageId);
    event Process(uint32 indexed origin, bytes32 indexed sender, address indexed recipient);
    event ProcessId(bytes32 indexed messageId);

    function localDomain() external view returns (uint32);

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external payable returns (bytes32 messageId);

    function quoteDispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external view returns (uint256 fee);

    function delivered(bytes32 _messageId) external view returns (bool);
}
