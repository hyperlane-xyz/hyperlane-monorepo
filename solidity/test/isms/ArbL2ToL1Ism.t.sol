// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract ArbL2ToL1IsmTest is Test {
    uint8 internal constant HYPERLANE_VERSION = 1;
    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42161;

    address internal constant L2_ARBSYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    TestMailbox public l2Mailbox;
    ArbL2ToL1Hook public hook;
    ArbL2ToL1Hook public ism; // TODO: fix

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal encodedMessage;
    bytes32 internal messageId;

    function setUp() public {
        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    function deployArbHook() public {
        l2Mailbox = new TestMailbox(ARBITRUM_DOMAIN);
        hook = new ArbL2ToL1Hook(
            address(l2Mailbox),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(
                0xc005dc82818d67AF737725bD4bf75435d065D239
            ),
            L2_ARBSYS_ADDRESS
        );
    }

    function deployAll() public {
        deployArbHook();
    }

    function test_postDispatch() public {
        deployAll();

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        l2Mailbox.updateLatestDispatchedId(messageId);

        hook.postDispatch(encodedHookData, encodedMessage);
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                ARBITRUM_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }
}
