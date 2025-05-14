// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IMailbox} from "../interfaces/IMailbox.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

/**
 * @title SimpleMessageSenderReceiver
 * @notice A simple contract to test sending and receiving Hyperlane messages
 * using a Mailbox configured with PolymerISM.
 * Assumes Mailbox uses MockHook, so dispatch calls don't require value.
 */
contract SimpleMessageSenderReceiver is
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using TypeCasts for address;

    // --- State Variables ---

    /// @notice Address of the Mailbox contract on the local chain.
    IMailbox public immutable mailbox;
    /// @notice Address of the PolymerISM contract on the local chain (used when this contract receives messages).
    IInterchainSecurityModule public immutable polymerIsm;

    uint32 public messageCounter;
    bytes public latestReceivedMessage;
    uint32 public latestReceivedOrigin;
    bytes32 public latestReceivedSender;

    // --- Events ---

    event MessageSent(
        uint32 destinationDomain,
        address recipientAddress,
        bytes messageBody,
        bytes32 messageId
    );
    event MessageReceived(
        uint32 originDomain,
        bytes32 senderAddress,
        bytes messageBody
    );

    // --- Constructor ---

    /**
     * @notice Deploys the test contract.
     * @param _mailbox Address of the local Mailbox contract.
     * @param _polymerIsm Address of the local PolymerISM contract.
     */
    constructor(address _mailbox, address _polymerIsm) {
        require(_mailbox != address(0), "Invalid mailbox address");
        require(_polymerIsm != address(0), "Invalid ISM address");
        mailbox = IMailbox(_mailbox);
        polymerIsm = IInterchainSecurityModule(_polymerIsm);
    }

    // --- Sending Logic ---

    /**
     * @notice Dispatches a message via the local Mailbox.
     * @param _destinationDomain The target chain's domain ID.
     * @param _recipientAddress The address of the recipient contract on the destination chain.
     * @param _messageBody The content of the message to send.
     */
    function sendMessage(
        uint32 _destinationDomain,
        address _recipientAddress,
        bytes calldata _messageBody
    ) external {
        // Convert recipient address to bytes32 for Mailbox dispatch
        bytes32 recipientBytes32 = _recipientAddress.addressToBytes32();

        // Dispatch the message using the basic dispatch function.
        // Assumes Mailbox uses MockHook, so no msg.value is needed.
        bytes32 messageId = mailbox.dispatch(
            _destinationDomain,
            recipientBytes32,
            _messageBody
        );

        emit MessageSent(
            _destinationDomain,
            _recipientAddress,
            _messageBody,
            messageId
        );
    }

    // --- Receiving Logic (IMessageRecipient) ---

    /**
     * @notice Handles an incoming message delivered by the Mailbox.
     * @param _origin The domain ID of the chain where the message originated.
     * @param _sender The address (bytes32) of the contract that sent the message on the origin chain.
     * @param _body The body of the message.
     * @dev This function can only be successfully called by the local Mailbox contract
     * after it has verified the message using the specified ISM (PolymerISM in this case).
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _body
    ) external payable override {
        messageCounter++;
        latestReceivedOrigin = _origin;
        latestReceivedSender = _sender;
        latestReceivedMessage = _body;

        emit MessageReceived(_origin, _sender, _body);
    }

    // --- ISM Specification (ISpecifiesInterchainSecurityModule) ---

    /**
     * @notice Specifies the ISM to be used for verifying messages sent to this contract.
     * @return The address of the PolymerISM contract.
     */
    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return polymerIsm;
    }

    // --- View Functions ---

    function getLatestMessageDetails()
        external
        view
        returns (uint32 origin, bytes32 sender, bytes memory body, uint32 count)
    {
        return (
            latestReceivedOrigin,
            latestReceivedSender,
            latestReceivedMessage,
            messageCounter
        );
    }
}
