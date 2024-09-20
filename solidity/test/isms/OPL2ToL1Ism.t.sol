// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

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
        // Optimism messenger mock setup
        GAS_QUOTE = 120_000;
        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );

        deployAll();
        super.setUp();
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

    /* ============ helper functions ============ */

    function _expectOriginExternalBridgeCall(
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

    function _encodeExternalDestinationBridgeCall(
        address,
        /*_from*/
        address _to,
        uint256 _msgValue,
        bytes32 _messageId
    ) internal override returns (bytes memory) {
        vm.deal(address(portal), _msgValue);
        return _encodeFinalizeWithdrawalTx(_to, _msgValue, _messageId);
    }

    function _setExternalOriginSender(
        address _sender
    ) internal override returns (bytes memory) {
        l1Messenger.setXDomainMessageSender(_sender);
        return "AbstractMessageIdAuthorizedIsm: sender is not the hook";
    }

    // function test_verify_revertWhen_arbitraryCall() public {
    //     deployAll();

    //     bytes memory incorrectMetadata = _encodeFinalizeWithdrawalTx(address(portal), 0, messageId);

    //     vm.expectRevert("OPL2ToL1Ism: message not verified");
    //     ism.verify(incorrectMetadata, encodedMessage);
    // }

    function _externalBridgeDestinationCall(
        bytes memory,
        /*_encodedHookData*/
        uint256 _msgValue
    ) internal override {
        vm.deal(address(portal), _msgValue);
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: MOCK_NONCE,
                sender: L2_MESSENGER_ADDRESS,
                target: address(l1Messenger),
                value: _msgValue,
                gasLimit: uint256(GAS_QUOTE),
                data: _encodeMessengerCalldata(
                    address(ism),
                    _msgValue,
                    messageId
                )
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
