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
    mapping(uint256 nonce => bytes message) public inboundMessages;
    mapping(uint256 nonce => bytes metadata) public inboundMetadata;

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

    /// @dev addInboundMessage is used to add a message to the mailbox
    function addInboundMessage(bytes calldata message) public {
        inboundMessages[inboundUnprocessedNonce] = message;
        inboundUnprocessedNonce++;
    }

    /// @dev processNextInboundMessage is used to process the next inbound message
    function processNextInboundMessage() public payable {
        processInboundMessage(inboundProcessedNonce);
        inboundProcessedNonce++;
    }

    /// @dev processInboundMessage is used to process an inbound message
    function processInboundMessage(uint32 _nonce) public payable {
        bytes memory _message = inboundMessages[_nonce];
        bytes memory _metadata = inboundMetadata[_nonce];
        this.process{value: msg.value}(_metadata, _message);
    }

    /// @dev addInboundMetadata is used to add metadata to an inbound message.
    /// This metadata will be used to process the inbound message.
    function addInboundMetadata(uint32 _nonce, bytes memory metadata) public {
        inboundMetadata[_nonce] = metadata;
    }
}
