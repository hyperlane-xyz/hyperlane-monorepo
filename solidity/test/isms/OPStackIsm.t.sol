// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/console.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {MockOptimismMessenger} from "../../contracts/mock/MockOptimism.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {OPStackIsm} from "../../contracts/isms/hook/OPStackIsm.sol";
import {OPStackHook} from "../../contracts/hooks/OPStackHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {NotCrossChainCall} from "@openzeppelin/contracts/crosschain/errors.sol";

import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract OPStackIsmTest is ExternalBridgeTest {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    address internal constant L1_MESSENGER_ADDRESS =
        0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1;
    address internal constant L1_CANNONICAL_CHAIN =
        0x5E4e65926BA27467555EB562121fac00D24E9dD2;
    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint8 internal constant OPTIMISM_VERSION = 0;
    uint256 internal constant DEFAULT_GAS_LIMIT = 1_920_000;

    address internal alice = address(0x1);

    MockOptimismMessenger internal l1Messenger;
    MockOptimismMessenger internal l2Messenger;

    event RelayedMessage(bytes32 indexed msgHash);

    event FailedRelayedMessage(bytes32 indexed msgHash);

    event ReceivedMessage(bytes32 indexed messageId);

    function setUp() public override {
        GAS_QUOTE = 0;

        vm.etch(
            L1_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );
        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );
        l1Messenger = MockOptimismMessenger(L1_MESSENGER_ADDRESS);
        l2Messenger = MockOptimismMessenger(L2_MESSENGER_ADDRESS);

        deployAll();
        super.setUp();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        hook = new OPStackHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            L1_MESSENGER_ADDRESS
        );
    }

    function deployIsm() public {
        ism = new OPStackIsm(L2_MESSENGER_ADDRESS);
    }

    function deployAll() public {
        deployIsm();
        deployHook();

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        l2Messenger.setXDomainMessageSender(address(hook));
    }

    function test_verify_revertWhen_invalidMetadata() public override {
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    function test_verify_revertsWhen_incorrectMessageId() public override {
        bytes32 incorrectMessageId = keccak256("incorrect message id");

        _externalBridgeDestinationCall(
            _encodeHookData(incorrectMessageId, 0),
            0
        );
        assertFalse(ism.isVerified(testMessage));
    }

    /* ============ helper functions ============ */

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            L1_MESSENGER_ADDRESS,
            abi.encodeCall(
                ICrossDomainMessenger.sendMessage,
                (address(ism), _encodedHookData, uint32(DEFAULT_GAS_LIMIT))
            )
        );
    }

    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) internal override {
        vm.deal(L2_MESSENGER_ADDRESS, _msgValue);
        l2Messenger.relayMessage(
            0,
            address(hook),
            address(ism),
            _msgValue,
            uint32(GAS_QUOTE),
            _encodedHookData
        );
    }

    function _encodeExternalDestinationBridgeCall(
        address /*_from*/,
        address /*_to*/,
        uint256 /*_msgValue*/,
        bytes32 /*_messageId*/
    ) internal pure override returns (bytes memory) {
        return new bytes(0);
    }

    // SKIP - no external bridge call
    function test_preVerifyMessage_externalBridgeCall() public override {}

    function test_verify_msgValue_externalBridgeCall() public override {}

    function test_verify_revertsWhen_invalidIsm() public override {}

    function test_verify_false_arbitraryCall() public override {}

    /* ============ ISM.preVerifyMessage ============ */

    function test_verify_revertsWhen_notAuthorizedHook() public override {
        // needs to be called by the canonical messenger on Optimism
        vm.expectRevert(NotCrossChainCall.selector);
        ism.preVerifyMessage(messageId, 0);

        vm.startPrank(L2_MESSENGER_ADDRESS);
        _setExternalOriginSender(address(this));

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ism.preVerifyMessage(messageId, 0);
    }

    function _setExternalOriginSender(
        address _sender
    ) internal override returns (bytes memory) {
        l2Messenger.setXDomainMessageSender(_sender);
        return "";
    }

    /* ============ ISM.verify ============ */

    function test_verify_tooMuchValue() public {
        uint256 _msgValue = 2 ** 255 + 1;

        vm.expectRevert("AbstractMessageIdAuthorizedIsm: invalid msg.value");
        _externalBridgeDestinationCall(
            _encodeHookData(messageId, _msgValue),
            _msgValue
        );

        assertFalse(ism.isVerified(encodedMessage));

        assertEq(address(ism).balance, 0);
        assertEq(address(testRecipient).balance, 0);
    }

    /* ============ helper functions ============ */
}
