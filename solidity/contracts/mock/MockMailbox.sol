// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Versioned} from "../upgrade/Versioned.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Mailbox} from "../Mailbox.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

import {TestIsm} from "../test/TestIsm.sol";
import {TestPostDispatchHook} from "../test/TestPostDispatchHook.sol";

contract MockMailbox is Mailbox {
    using Message for bytes;

    uint32 public inboundUnprocessedNonce = 0;
    uint32 public inboundProcessedNonce = 0;

    mapping(uint32 => MockMailbox) public remoteMailboxes;
    mapping(uint256 => bytes) public inboundMessages;

    constructor(uint32 _domain) Mailbox(_domain) {
        TestIsm ism = new TestIsm();
        defaultIsm = ism;

        TestPostDispatchHook hook = new TestPostDispatchHook();
        defaultHook = hook;
        requiredHook = hook;

        _transferOwnership(msg.sender);
        _disableInitializers();
    }

    function addRemoteMailbox(uint32 _domain, MockMailbox _mailbox) external {
        remoteMailboxes[_domain] = _mailbox;
    }

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        bytes calldata metadata,
        IPostDispatchHook hook
    ) public payable override returns (bytes32) {
        bytes memory message = _buildMessage(
            destinationDomain,
            recipientAddress,
            messageBody
        );
        bytes32 id = super.dispatch(
            destinationDomain,
            recipientAddress,
            messageBody,
            metadata,
            hook
        );

        MockMailbox _destinationMailbox = remoteMailboxes[destinationDomain];
        require(
            address(_destinationMailbox) != address(0),
            "Missing remote mailbox"
        );
        _destinationMailbox.addInboundMessage(message);

        return id;
    }

    function addInboundMessage(bytes calldata message) external {
        inboundMessages[inboundUnprocessedNonce] = message;
        inboundUnprocessedNonce++;
    }

    function processNextInboundMessage() public payable {
        bytes memory _message = inboundMessages[inboundProcessedNonce];
        Mailbox(address(this)).process{value: msg.value}("", _message);
        inboundProcessedNonce++;
    }

    function handleNextInboundMessage() public payable {
        bytes memory _message = inboundMessages[inboundProcessedNonce];
        MockMailbox(address(this)).handleMessage(_message);
        inboundProcessedNonce++;
    }

    function handleAllInboundMessages() public payable {
        while (inboundProcessedNonce < inboundUnprocessedNonce) {
            handleNextInboundMessage();
        }
    }

    function handleMessage(bytes calldata message) external {
        IMessageRecipient(message.recipientAddress()).handle(
            message.origin(),
            message.sender(),
            message.body()
        );
    }

    function processInboundMessage(uint32 _nonce) public payable {
        bytes memory _message = inboundMessages[_nonce];
        Mailbox(address(this)).process{value: msg.value}("", _message);
    }
}
