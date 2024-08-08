// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {ArbL2ToL1Ism} from "../../contracts/isms/hook/ArbL2ToL1Ism.sol";
import {MockArbBridge, MockArbSys} from "../../contracts/mock/MockArbBridge.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract ArbL2ToL1IsmTest is Test {
    uint8 internal constant HYPERLANE_VERSION = 1;
    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42161;
    uint256 internal constant GAS_QUOTE = 120_000;

    uint256 internal constant MOCK_LEAF_INDEX = 40160;
    uint256 internal constant MOCK_L2_BLOCK = 54220000;
    uint256 internal constant MOCK_L1_BLOCK = 6098300;

    address internal constant L2_ARBSYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    MockArbBridge internal arbBridge;
    TestMailbox public l2Mailbox;
    ArbL2ToL1Hook public hook;
    ArbL2ToL1Ism public ism;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal encodedMessage;
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));
    bytes32 internal messageId;

    function setUp() public {
        // Arbitrum bridge mock setup
        vm.etch(L2_ARBSYS_ADDRESS, address(new MockArbSys()).code);

        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHook() public {
        l2Mailbox = new TestMailbox(ARBITRUM_DOMAIN);
        hook = new ArbL2ToL1Hook(
            address(l2Mailbox),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L2_ARBSYS_ADDRESS,
            GAS_QUOTE
        );
    }

    function deployIsm() public {
        arbBridge = new MockArbBridge();

        ism = new ArbL2ToL1Ism(address(arbBridge));
    }

    function deployAll() public {
        deployIsm();
        deployHook();

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
    }

    function test_postDispatch() public {
        deployAll();

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        l2Mailbox.updateLatestDispatchedId(messageId);

        vm.expectCall(
            L2_ARBSYS_ADDRESS,
            abi.encodeCall(
                MockArbSys.sendTxToL1,
                (address(ism), encodedHookData)
            )
        );
        hook.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_revertWhen_chainIDNotSupported() public {
        deployAll();

        bytes memory message = MessageUtils.formatMessage(
            0,
            uint32(0),
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            2, // wrong domain
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );

        l2Mailbox.updateLatestDispatchedId(Message.id(message));
        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        hook.postDispatch(testMetadata, message);
    }

    function test_postDispatch_revertWhen_notLastDispatchedMessage() public {
        deployAll();

        // vm.expectRevert(
        //     "AbstractMessageIdAuthHook: message not latest dispatched"
        // );
        // hook.postDispatch(testMetadata, encodedMessage);
    }

    function test_verify_outboxCall() public {
        deployAll();

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(ism),
            messageId
        );

        arbBridge.setL2ToL1Sender(address(hook));
        assertTrue(ism.verify(encodedOutboxTxMetadata, encodedMessage));
    }

    function test_verify_statefulVerify() public {
        deployAll();

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        arbBridge.setL2ToL1Sender(address(hook));
        arbBridge.executeTransaction{value: 1 ether}(
            new bytes32[](0),
            MOCK_LEAF_INDEX,
            address(hook),
            address(ism),
            MOCK_L2_BLOCK,
            MOCK_L1_BLOCK,
            block.timestamp,
            1 ether,
            encodedHookData
        );

        vm.etch(address(arbBridge), new bytes(0)); // this is a way to test that the arbBridge isn't called again
        assertTrue(ism.verify(new bytes(0), encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_statefulAndOutbox() public {
        deployAll();

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        arbBridge.setL2ToL1Sender(address(hook));
        arbBridge.executeTransaction{value: 1 ether}(
            new bytes32[](0),
            MOCK_LEAF_INDEX,
            address(hook),
            address(ism),
            MOCK_L2_BLOCK,
            MOCK_L1_BLOCK,
            block.timestamp,
            1 ether,
            encodedHookData
        );

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(ism),
            messageId
        );

        vm.etch(address(arbBridge), new bytes(0)); // this is a way to test that the arbBridge isn't called again
        assertTrue(ism.verify(encodedOutboxTxMetadata, encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_revertsWhen_noStatefulOrOutbox() public {
        deployAll();

        vm.expectRevert();
        ism.verify(new bytes(0), encodedMessage);
    }

    function test_verify_revertsWhen_notAuthorizedHook() public {
        deployAll();

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(this),
            address(ism),
            messageId
        );

        arbBridge.setL2ToL1Sender(address(hook));

        vm.expectRevert("ArbL2ToL1Ism: l2Sender != authorizedHook");
        ism.verify(encodedOutboxTxMetadata, encodedMessage);
    }

    function test_verify_revertsWhen_invalidIsm() public {
        deployAll();

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(this),
            messageId
        );

        arbBridge.setL2ToL1Sender(address(hook));

        vm.expectRevert(); // BridgeCallFailed()
        ism.verify(encodedOutboxTxMetadata, encodedMessage);
    }

    function test_verify_revertsWhen_incorrectMessageId() public {
        deployAll();

        bytes32 incorrectMessageId = keccak256("incorrect message id");

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(ism),
            incorrectMessageId
        );

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (incorrectMessageId)
        );

        arbBridge.setL2ToL1Sender(address(hook));

        // through outbox call
        vm.expectRevert("ArbL2ToL1Ism: invalid message id");
        ism.verify(encodedOutboxTxMetadata, encodedMessage);

        // through statefulVerify
        arbBridge.executeTransaction(
            new bytes32[](0),
            MOCK_LEAF_INDEX,
            address(hook),
            address(ism),
            MOCK_L2_BLOCK,
            MOCK_L1_BLOCK,
            block.timestamp,
            0,
            encodedHookData
        );

        vm.etch(address(arbBridge), new bytes(0)); // to stop the outbox route
        vm.expectRevert();
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    // function test_verify_withMsgValue

    /* ============ helper functions ============ */

    function _encodeOutboxTx(
        address _hook,
        address _ism,
        bytes32 _messageId
    ) internal view returns (bytes memory) {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (_messageId)
        );

        bytes32[] memory proof = new bytes32[](16);
        return
            abi.encode(
                proof,
                MOCK_LEAF_INDEX,
                _hook,
                _ism,
                MOCK_L2_BLOCK,
                MOCK_L1_BLOCK,
                block.timestamp,
                encodedHookData
            );
    }

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
