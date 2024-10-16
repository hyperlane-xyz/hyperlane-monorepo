// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";

import {ICrossL2Inbox} from "../../contracts/interfaces/optimism/ICrossL2Inbox.sol";

import {ICrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MockL2toL2CrossDomainMessenger, MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {SuperchainHook} from "../../contracts/hooks/SuperchainHook.sol";
import {SuperchainISM} from "../../contracts/isms/hook/SuperchainIsm.sol";

contract SuperchainIsmTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    MockL2toL2CrossDomainMessenger internal messenger;
    SuperchainHook hook;
    SuperchainISM ism;
    TestMailbox mailbox;
    uint32 origin = 12345;
    uint32 destination = 54321;
    TestRecipient testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    function setUp() public {
        messenger = new MockL2toL2CrossDomainMessenger();
        mailbox = new TestMailbox(origin);
        testRecipient = new TestRecipient();
        ism = new SuperchainISM(address(messenger));

        hook = new SuperchainHook(
            address(mailbox),
            destination,
            address(ism).addressToBytes32(),
            address(messenger),
            100
        );
        ism.setAuthorizedHook(address(hook).addressToBytes32());
    }

    function test_verify_successfully() public {
        bytes memory message = mailbox.buildOutboundMessage(
            3,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
        ICrossL2Inbox.Identifier memory id = ICrossL2Inbox.Identifier({
            origin: address(hook),
            blockNumber: 1,
            logIndex: 1,
            timestamp: 1,
            chainId: destination
        });
        bytes memory call = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            message.id()
        );
        bytes memory messengerMetadata = abi.encode(
            id,
            messenger.encodeCall(address(hook), address(ism), call)
        );
        assertTrue(ism.verify(messengerMetadata, message));
        assertTrue(ism.isVerified(message));
    }
}
