// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ============ External Imports ============

import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {OwnerIsCreator} from "@chainlink/contracts-ccip/src/v0.8/shared/access/OwnerIsCreator.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * THIS IS AN EXAMPLE CONTRACT THAT USES HARDCODED VALUES FOR CLARITY.
 * THIS IS AN EXAMPLE CONTRACT THAT USES UN-AUDITED CODE.
 * DO NOT USE THIS CODE IN PRODUCTION.
 */

/// @title - A simple messenger contract for sending/receving string data across chains.
contract Receiver is CCIPReceiver, OwnerIsCreator {
    // Custom errors to provide more descriptive revert messages.
    error SourceChainNotAllowlisted(uint64 sourceChainSelector); // Used when the source chain has not been allowlisted by the contract owner.
    error SenderNotAllowlisted(address sender); // Used when the sender has not been allowlisted by the contract owner.

    // Event emitted when a message is received from another chain.
    event MessageReceived(
        bytes32 indexed messageId, // The unique ID of the CCIP message.
        uint64 indexed sourceChainSelector, // The chain selector of the source chain.
        address sender, // The address of the sender from the source chain.
        bytes payload // The payload that was received.
    );

    bytes32 private s_lastReceivedMessageId; // Store the last received messageId.
    bytes private s_lastReceivedPayload; // Store the last received id.

    address public CCIPIsm; // The address of CCIP Ism to call during ccipReceive

    // Mapping to keep track of allowlisted source chains.
    mapping(uint64 => bool) public allowlistedSourceChains;

    // Mapping to keep track of allowlisted senders.
    mapping(address => bool) public allowlistedSenders;

    // ============ Constructor ============

    // @notice Constructor initializes the contract with the router address.
    // @param _router The address of the router contract.
    constructor(address _router, address _ism) CCIPReceiver(_router) {
        CCIPIsm = _ism;
    }

    // ============ Modifiers ============

    /// @dev Modifier that checks if the chain with the given sourceChainSelector is allowlisted and if the sender is allowlisted.
    /// @param _sourceChainSelector The selector of the destination chain.
    /// @param _sender The address of the sender.
    modifier onlyAllowlisted(uint64 _sourceChainSelector, address _sender) {
        if (!allowlistedSourceChains[_sourceChainSelector])
            revert SourceChainNotAllowlisted(_sourceChainSelector);
        if (!allowlistedSenders[_sender]) revert SenderNotAllowlisted(_sender);
        _;
    }

    // ============ Internal functions ============

    /// handle a received message
    function _ccipReceive(
        Client.Any2EVMMessage memory any2EvmMessage
    )
        internal
        override
        onlyAllowlisted(
            any2EvmMessage.sourceChainSelector,
            abi.decode(any2EvmMessage.sender, (address))
        ) // Make sure source chain and sender are allowlisted
    {
        s_lastReceivedMessageId = any2EvmMessage.messageId; // fetch the messageId
        s_lastReceivedPayload = abi.decode(any2EvmMessage.data, (bytes)); // abi-decoding of the sent payload

        (bool success, ) = CCIPIsm.call(s_lastReceivedPayload); // verifyMessageId(bytes32)
        require (success, "Call to CCIP Ism failed");

        emit MessageReceived(
            any2EvmMessage.messageId,
            any2EvmMessage.sourceChainSelector, // fetch the source chain identifier (aka selector)
            abi.decode(any2EvmMessage.sender, (address)), // abi-decoding of the sender address,
            s_lastReceivedPayload
        );
    }

    // ============ Public / External functions ============

    /// @dev Updates the allowlist status of a source chain for transactions.
    function allowlistSourceChain(
        uint64 _sourceChainSelector,
        bool allowed
    ) external onlyOwner {
        allowlistedSourceChains[_sourceChainSelector] = allowed;
    }

    /// @dev Updates the allowlist status of a sender for transactions.
    function allowlistSender(address _sender, bool allowed) external onlyOwner {
        allowlistedSenders[_sender] = allowed;
    }

    /// @notice Fetches the details of the last received message.
    /// @return messageId The ID of the last received message.
    /// @return payload The last received payload.
    function getLastReceivedMessageDetails()
        external
        view
        returns (bytes32 messageId, bytes memory payload)
    {
        return (s_lastReceivedMessageId, s_lastReceivedPayload);
    }

    /// @dev Sets the address for Ism to verify message
    function setIsm(address _ism) external  onlyOwner {
        CCIPIsm = _ism;
    }
}