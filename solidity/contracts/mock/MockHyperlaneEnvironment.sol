// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "./MockMailbox.sol";
import "../test/TestInterchainGasPaymaster.sol";
import "../test/TestIsm.sol";

import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockHyperlaneEnvironment {
    uint32 public originDomain;
    uint32 public destinationDomain;

    mapping(uint32 => MockMailbox) public mailboxes;
    mapping(uint32 => TestInterchainGasPaymaster) public igps;
    mapping(uint32 => IInterchainSecurityModule) public isms;

    constructor(uint32 _originDomain, uint32 _destinationDomain) {
        originDomain = _originDomain;
        destinationDomain = _destinationDomain;

        MockMailbox originMailbox = new MockMailbox(_originDomain);
        MockMailbox destinationMailbox = new MockMailbox(_destinationDomain);

        originMailbox.addRemoteMailbox(_destinationDomain, destinationMailbox);
        destinationMailbox.addRemoteMailbox(_originDomain, originMailbox);

        isms[originDomain] = new TestIsm();
        isms[destinationDomain] = new TestIsm();

        originMailbox.setDefaultIsm(address(isms[originDomain]));
        destinationMailbox.setDefaultIsm(address(isms[destinationDomain]));

        originMailbox.transferOwnership(msg.sender);
        destinationMailbox.transferOwnership(msg.sender);

        mailboxes[_originDomain] = originMailbox;
        mailboxes[_destinationDomain] = destinationMailbox;
    }

    function processNextPendingMessage() public payable {
        mailboxes[destinationDomain].processNextInboundMessage{
            value: msg.value
        }();
    }

    function processInboundMessage(uint32 _nonce) public payable {
        mailboxes[destinationDomain].processInboundMessage{value: msg.value}(
            _nonce
        );
    }

    function processNextPendingMessageFromDestination() public {
        mailboxes[originDomain].processNextInboundMessage();
    }
}
