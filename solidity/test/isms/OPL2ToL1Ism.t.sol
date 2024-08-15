// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IOptimismPortal} from "../../contracts/interfaces/optimism/IOptimismPortal.sol";
import {ICrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MockOptimismMessenger, MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {OPL2ToL1Hook} from "../../contracts/hooks/OPL2ToL1Hook.sol";
import {OPL2ToL1Ism} from "../../contracts/isms/hook/OPL2ToL1Ism.sol";

contract OPL2ToL1IsmTest is Test {
    uint8 internal constant HYPERLANE_VERSION = 1;
    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant OPTIMISM_DOMAIN = 10;
    uint32 internal constant GAS_QUOTE = 120_000;

    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint256 internal constant MOCK_NONCE = 0;

    TestMailbox public l2Mailbox;
    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal encodedMessage;
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));
    bytes32 internal messageId;

    MockOptimismPortal internal portal;
    MockOptimismMessenger internal l1Messenger;
    OPL2ToL1Hook public hook;
    OPL2ToL1Ism public ism;

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function setUp() public {
        // Optimism messenger mock setup
        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );

        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    function deployHook() public {
        l2Mailbox = new TestMailbox(OPTIMISM_DOMAIN);
        hook = new OPL2ToL1Hook(
            address(l2Mailbox),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L2_MESSENGER_ADDRESS,
            GAS_QUOTE
        );
    }

    function deployIsm() public {
        l1Messenger = new MockOptimismMessenger();
        portal = new MockOptimismPortal();
        l1Messenger.setPORTAL(address(portal));

        ism = new OPL2ToL1Ism(address(l1Messenger));
    }

    function deployAll() public {
        deployIsm();
        deployHook();

        l1Messenger.setXDomainMessageSender(address(hook));
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
            L2_MESSENGER_ADDRESS,
            abi.encodeCall(
                ICrossDomainMessenger.sendMessage,
                (address(ism), encodedHookData, GAS_QUOTE)
            )
        );
        hook.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_revertWhen_chainIDNotSupported() public {
        deployAll();

        bytes memory message = MessageUtils.formatMessage(
            0,
            uint32(0),
            OPTIMISM_DOMAIN,
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

        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        hook.postDispatch(testMetadata, encodedMessage);
    }

    function test_verify_directWithdrawalCall() public {
        deployAll();

        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(ism),
            0,
            messageId
        );

        assertTrue(ism.verify(encodedWithdrawalTx, encodedMessage));
    }

    function test_verify_directWithdrawalCall_revertsWhen_invalidSender()
        public
    {
        deployAll();
        l1Messenger.setXDomainMessageSender(address(this));

        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(ism),
            0,
            messageId
        );

        vm.expectRevert(); // evmRevert in MockOptimismPortal
        ism.verify(encodedWithdrawalTx, encodedMessage);
    }

    function test_verify_statefulVerify() public {
        deployAll();

        vm.deal(address(portal), 1 ether);
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: MOCK_NONCE,
                sender: L2_MESSENGER_ADDRESS,
                target: address(l1Messenger),
                value: 1 ether,
                gasLimit: uint256(GAS_QUOTE),
                data: _encodeMessengerCalldata(address(ism), 1 ether, messageId)
            });
        portal.finalizeWithdrawalTransaction(withdrawal);

        vm.etch(address(portal), new bytes(0)); // this is a way to test that the portal isn't called again
        assertTrue(ism.verify(new bytes(0), encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether); // testing msg.value
    }

    function test_verify_statefulAndDirectWithdrawal() public {
        deployAll();

        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: MOCK_NONCE,
                sender: L2_MESSENGER_ADDRESS,
                target: address(l1Messenger),
                value: 0,
                gasLimit: uint256(GAS_QUOTE),
                data: _encodeMessengerCalldata(address(ism), 0, messageId)
            });
        portal.finalizeWithdrawalTransaction(withdrawal);

        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(ism),
            0,
            messageId
        );

        vm.etch(address(portal), new bytes(0)); // this is a way to test that the portal isn't called again
        assertTrue(ism.verify(encodedWithdrawalTx, encodedMessage));
    }

    function test_verify_revertsWhen_noStatefulAndDirectWithdrawal() public {
        deployAll();

        vm.expectRevert();
        ism.verify(new bytes(0), encodedMessage);
    }

    function test_verify_revertsWhen_invalidIsm() public {
        deployAll();

        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(this),
            0,
            messageId
        );

        vm.expectRevert(); // evmRevert in MockOptimismPortal
        ism.verify(encodedWithdrawalTx, encodedMessage);
    }

    function test_verify_revertsWhen_incorrectMessageId() public {
        deployAll();

        bytes32 incorrectMessageId = keccak256("incorrect message id");

        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(this),
            0,
            incorrectMessageId
        );

        // through portal call
        vm.expectRevert("OPL2ToL1Ism: invalid message id");
        ism.verify(encodedWithdrawalTx, encodedMessage);

        // through statefulVerify
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: MOCK_NONCE,
                sender: L2_MESSENGER_ADDRESS,
                target: address(l1Messenger),
                value: 0,
                gasLimit: uint256(GAS_QUOTE),
                data: _encodeMessengerCalldata(
                    address(ism),
                    0,
                    incorrectMessageId
                )
            });
        portal.finalizeWithdrawalTransaction(withdrawal);

        vm.etch(address(portal), new bytes(0)); // to stop the portal route
        vm.expectRevert(); // evmRevert()
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                OPTIMISM_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function _encodeMessengerCalldata(
        address _ism,
        uint256 _value,
        bytes32 _messageId
    ) internal view returns (bytes memory) {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (_messageId)
        );

        return
            abi.encodeCall(
                ICrossDomainMessenger.relayMessage,
                (
                    MOCK_NONCE,
                    address(hook),
                    _ism,
                    _value,
                    uint256(GAS_QUOTE),
                    encodedHookData
                )
            );
    }

    function _encodeFinalizeWithdrawalTx(
        address _ism,
        uint256 _value,
        bytes32 _messageId
    ) internal view returns (bytes memory) {
        return
            abi.encode(
                MOCK_NONCE,
                L2_MESSENGER_ADDRESS,
                l1Messenger,
                _value,
                uint256(GAS_QUOTE),
                _encodeMessengerCalldata(_ism, _value, _messageId)
            );
    }
}
