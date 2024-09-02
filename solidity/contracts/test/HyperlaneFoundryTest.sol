// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

import {Message} from "../../contracts/libs/Message.sol";

import {ForkTestMailbox} from "../../contracts/test/ForkTestMailbox.sol";

contract HyperlaneFoundryTest is Test {
    using Message for bytes;

    uint32 public inboundProcessedNonce;

    bytes[] public messages;

    mapping(uint32 domain => uint256 forkId) public domain2fork;
    mapping(uint32 domain => address mailbox) public domain2mailbox;
    mapping(uint32 domain => address defaultIsm) public domain2ism;

    function setUpMailbox(uint256 forkId, address mailbox) internal {
        vm.selectFork(forkId);
        IMailbox _mailbox = IMailbox(mailbox);
        uint32 domain = _mailbox.localDomain();
        address defaultIsm = address(_mailbox.defaultIsm());

        domain2fork[domain] = forkId;
        domain2mailbox[domain] = mailbox;
        domain2ism[domain] = defaultIsm;

        ForkTestMailbox _testMailbox = new ForkTestMailbox(
            domain,
            address(this)
        );
        vm.etch(mailbox, address(_testMailbox).code);
        vm.mockCall(
            defaultIsm,
            abi.encodeWithSelector(IInterchainSecurityModule.verify.selector),
            abi.encode(true)
        );
    }

    function addInboundMessage(bytes calldata message) external {
        messages.push(message);
    }

    function processNextInboundMessage() public {
        this._process(messages[inboundProcessedNonce++]);
    }

    function _process(bytes calldata message) public {
        vm.selectFork(domain2fork[message.destination()]);
        IMailbox(domain2mailbox[message.destination()]).process("", message);
    }

    function mockDefaultIsm(uint32 domain, bool _verify) internal {
        vm.selectFork(domain2fork[domain]);
        mockIsm(domain2ism[domain], _verify);
    }

    function mockRecipientIsm(
        uint32 domain,
        ISpecifiesInterchainSecurityModule recipient,
        bool _verify
    ) internal {
        vm.selectFork(domain2fork[domain]);
        mockIsm(address(recipient.interchainSecurityModule()), _verify);
    }

    function mockIsm(address ism, bool _verify) internal {
        vm.mockCall(
            ism,
            abi.encodeWithSelector(IInterchainSecurityModule.verify.selector),
            abi.encode(_verify)
        );
    }
}
