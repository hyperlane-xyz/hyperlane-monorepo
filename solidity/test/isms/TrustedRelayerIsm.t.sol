// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TrustedRelayerIsm} from "../../contracts/isms/TrustedRelayerIsm.sol";

contract TrustedRelayerIsmTest is Test {
    using TypeCasts for address;

    uint32 localDomain = 12345;
    uint32 remoteDomain = 54321;

    TestMailbox mailbox;
    TrustedRelayerIsm ism;
    TestRecipient recipient;

    address relayer;

    function setUp() public {
        relayer = msg.sender;
        recipient = new TestRecipient();
        mailbox = new TestMailbox(12345);
        ism = new TrustedRelayerIsm(address(mailbox), relayer);
        recipient.setInterchainSecurityModule(address(ism));
    }

    function test_revertsWhen_invalidMailboxOrRelayer() public {
        vm.expectRevert("TrustedRelayerIsm: invalid relayer");
        new TrustedRelayerIsm(address(mailbox), address(0));
        vm.expectRevert("TrustedRelayerIsm: invalid mailbox");
        new TrustedRelayerIsm(relayer, relayer);
    }

    function test_verify(
        uint32 origin,
        bytes32 sender,
        bytes calldata body
    ) public {
        bytes memory message = mailbox.buildInboundMessage(
            origin,
            address(recipient).addressToBytes32(),
            sender,
            body
        );
        vm.expectRevert("Mailbox: ISM verification failed");
        mailbox.process("", message);
        assertFalse(ism.verify("", message));

        vm.prank(relayer);
        mailbox.process("", message);
        assertTrue(ism.verify("", message));
    }
}
