// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Versioned} from "../upgrade/Versioned.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract MockMailbox is Versioned {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    // Domain of chain on which the contract is deployed

    // ============ Constants ============
    uint32 public immutable localDomain;
    uint256 public constant MAX_MESSAGE_BODY_BYTES = 2 * 2**10;

    uint32 public outboundNonce = 0;
    uint32 public inboundUnprocessedNonce = 0;
    uint32 public inboundProcessedNonce = 0;
    IInterchainSecurityModule public defaultIsm;
    mapping(uint32 => MockMailbox) public remoteMailboxes;
    mapping(uint256 => MockMessage) public inboundMessages;

    struct MockMessage {
        uint32 nonce;
        uint32 origin;
        address sender;
        address recipient;
        bytes body;
    }

    constructor(uint32 _domain) {
        localDomain = _domain;
    }

    function setDefaultIsm(IInterchainSecurityModule _module) external {
        defaultIsm = _module;
    }

    function addRemoteMailbox(uint32 _domain, MockMailbox _mailbox) external {
        remoteMailboxes[_domain] = _mailbox;
    }

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (bytes32) {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        MockMailbox _destinationMailbox = remoteMailboxes[_destinationDomain];
        require(
            address(_destinationMailbox) != address(0),
            "Missing remote mailbox"
        );
        _destinationMailbox.addInboundMessage(
            outboundNonce,
            localDomain,
            msg.sender,
            _recipientAddress.bytes32ToAddress(),
            _messageBody
        );
        outboundNonce++;
        return bytes32(0);
    }

    function addInboundMessage(
        uint32 _nonce,
        uint32 _origin,
        address _sender,
        address _recipient,
        bytes calldata _body
    ) external {
        inboundMessages[inboundUnprocessedNonce] = MockMessage(
            _nonce,
            _origin,
            _sender,
            _recipient,
            _body
        );
        inboundUnprocessedNonce++;
    }

    function processNextInboundMessage() public {
        MockMessage memory _message = inboundMessages[inboundProcessedNonce];
        address _recipient = _message.recipient;
        IInterchainSecurityModule _ism = _recipientIsm(_recipient);
        if (address(_ism) != address(0)) {
            // Do not pass any metadata because we expect to
            // be using TestIsms
            require(_ism.verify("", _encode(_message)), "ISM verify failed");
        }

        IMessageRecipient(_message.recipient).handle(
            _message.origin,
            _message.sender.addressToBytes32(),
            _message.body
        );
        inboundProcessedNonce++;
    }

    function _encode(MockMessage memory _message)
        private
        view
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                VERSION,
                _message.nonce,
                _message.origin,
                TypeCasts.addressToBytes32(_message.sender),
                localDomain,
                TypeCasts.addressToBytes32(_message.recipient),
                _message.body
            );
    }

    function _recipientIsm(address _recipient)
        private
        view
        returns (IInterchainSecurityModule)
    {
        try
            ISpecifiesInterchainSecurityModule(_recipient)
                .interchainSecurityModule()
        returns (IInterchainSecurityModule _val) {
            if (address(_val) != address(0)) {
                return _val;
            }
        } catch {}
        return defaultIsm;
    }
}
