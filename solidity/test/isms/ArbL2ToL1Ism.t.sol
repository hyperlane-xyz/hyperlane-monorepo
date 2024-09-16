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
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract ArbL2ToL1IsmTest is ExternalBridgeTest {
    uint256 internal constant MOCK_LEAF_INDEX = 40160;
    uint256 internal constant MOCK_L2_BLOCK = 54220000;
    uint256 internal constant MOCK_L1_BLOCK = 6098300;

    address internal constant L2_ARBSYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    MockArbBridge internal arbBridge;

    function setUp() public override {
        ORIGIN_DOMAIN = 42161;
        DESTINATION_DOMAIN = 1;
        GAS_QUOTE = 120_000;
        super.setUp();

        // Arbitrum bridge mock setup
        vm.etch(L2_ARBSYS_ADDRESS, address(new MockArbSys()).code);

        deployAll();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        hook = new ArbL2ToL1Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
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

    function _expectOriginBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            L2_ARBSYS_ADDRESS,
            abi.encodeCall(
                MockArbSys.sendTxToL1,
                (address(ism), _encodedHookData)
            )
        );
    }

    function test_verify_outboxCall() public {
        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(ism),
            messageId,
            1 ether
        );

        vm.deal(address(arbBridge), 1 ether);
        arbBridge.setL2ToL1Sender(address(hook));
        assertTrue(ism.verify(encodedOutboxTxMetadata, encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function _bridgeDestinationCall(
        bytes memory _encodedHookData
    ) internal override {
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
            _encodedHookData
        );
    }

    // function test_verify_statefulVerify() public {
    //     bytes memory encodedHookData = abi.encodeCall(AbstractMessageIdAuthorizedIsm.verifyMessageId, (messageId));

    //     vm.etch(address(arbBridge), new bytes(0)); // this is a way to test that the arbBridge isn't called again
    //     assertTrue(ism.verify(new bytes(0), encodedMessage));
    //     assertEq(address(testRecipient).balance, 1 ether);
    // }

    function test_verify_statefulAndOutbox() public {
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
            messageId,
            1 ether
        );

        vm.etch(address(arbBridge), new bytes(0)); // this is a way to test that the arbBridge isn't called again
        assertTrue(ism.verify(encodedOutboxTxMetadata, encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_revertsWhen_notAuthorizedHook() public {
        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(this),
            address(ism),
            messageId,
            0
        );

        arbBridge.setL2ToL1Sender(address(this));

        vm.expectRevert("ArbL2ToL1Ism: l2Sender != authorizedHook");
        ism.verify(encodedOutboxTxMetadata, encodedMessage);
    }

    function test_verify_revertsWhen_invalidIsm() public {
        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(this),
            messageId,
            0
        );

        arbBridge.setL2ToL1Sender(address(hook));

        vm.expectRevert(); // BridgeCallFailed()
        ism.verify(encodedOutboxTxMetadata, encodedMessage);
    }

    function test_verify_revertsWhen_incorrectMessageId() public {
        bytes32 incorrectMessageId = keccak256("incorrect message id");

        bytes memory encodedOutboxTxMetadata = _encodeOutboxTx(
            address(hook),
            address(ism),
            incorrectMessageId,
            0
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

    /* ============ helper functions ============ */

    function _encodeOutboxTx(
        address _hook,
        address _ism,
        bytes32 _messageId,
        uint256 _value
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
                _value,
                encodedHookData
            );
    }
}
