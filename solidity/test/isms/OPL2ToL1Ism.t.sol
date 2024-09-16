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
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract OPL2ToL1IsmTest is ExternalBridgeTest {
    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint256 internal constant MOCK_NONCE = 0;

    MockOptimismPortal internal portal;
    MockOptimismMessenger internal l1Messenger;

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function setUp() public override {
        ORIGIN_DOMAIN = 10;
        DESTINATION_DOMAIN = 1;
        GAS_QUOTE = 120_000;
        super.setUp();

        // Optimism messenger mock setup
        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );

        deployAll();
    }

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        hook = new OPL2ToL1Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L2_MESSENGER_ADDRESS,
            uint32(GAS_QUOTE)
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

    function _expectOriginBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            L2_MESSENGER_ADDRESS,
            abi.encodeCall(
                ICrossDomainMessenger.sendMessage,
                (address(ism), _encodedHookData, uint32(GAS_QUOTE))
            )
        );
    }

    function test_verify_directWithdrawalCall() public {
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
        vm.expectRevert();
        ism.verify(new bytes(0), encodedMessage);
    }

    function test_verify_revertsWhen_invalidIsm() public {
        bytes memory encodedWithdrawalTx = _encodeFinalizeWithdrawalTx(
            address(this),
            0,
            messageId
        );

        vm.expectRevert(); // evmRevert in MockOptimismPortal
        ism.verify(encodedWithdrawalTx, encodedMessage);
    }

    function test_verify_revertsWhen_incorrectMessageId() public {
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

    function _bridgeDestinationCall(
        bytes memory _encodedHookData
    ) internal override {
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
    }

    function _encodeMessengerCalldata(
        address _ism,
        uint256 _value,
        bytes32 _messageId
    ) internal view returns (bytes memory) {
        bytes memory encodedHookData = _encodeHookData(_messageId);

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
