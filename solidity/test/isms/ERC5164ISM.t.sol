// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

import {IMessageDispatcher} from "../../contracts/interfaces/hooks/IMessageDispatcher.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {ERC5164Hook} from "../../contracts/hooks/aggregation/ERC5164Hook.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {ERC5164Ism} from "../../contracts/isms/hook/ERC5164Ism.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MockMessageDispatcher, MockMessageExecutor} from "../../contracts/mock/MockERC5164.sol";
import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";

contract ERC5164IsmTest is ExternalBridgeTest {
    using LibBit for uint256;
    using TypeCasts for address;
    using Message for bytes;
    using MessageUtils for bytes;

    IMessageDispatcher internal dispatcher;
    MockMessageExecutor internal executor;

    address internal alice = address(0x1);

    event MessageDispatched(
        bytes32 indexed messageId,
        address indexed from,
        uint256 indexed toChainId,
        address to,
        bytes data
    );

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function setUp() public override {
        dispatcher = new MockMessageDispatcher();
        executor = new MockMessageExecutor();
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        ism = new ERC5164Ism(address(executor));
        hook = new ERC5164Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            address(ism).addressToBytes32(),
            address(dispatcher)
        );
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        super.setUp();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            TESTS                            ///
    ///////////////////////////////////////////////////////////////////

    function test_constructor() public {
        vm.expectRevert("ERC5164Ism: invalid executor");
        ism = new ERC5164Ism(alice);

        vm.expectRevert("MailboxClient: invalid mailbox");
        hook = new ERC5164Hook(
            address(0),
            0,
            address(ism).addressToBytes32(),
            address(dispatcher)
        );

        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        hook = new ERC5164Hook(
            address(originMailbox),
            0,
            address(ism).addressToBytes32(),
            address(dispatcher)
        );

        vm.expectRevert("AbstractMessageIdAuthHook: invalid ISM");
        hook = new ERC5164Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            address(0).addressToBytes32(),
            address(dispatcher)
        );

        vm.expectRevert("ERC5164Hook: invalid dispatcher");
        hook = new ERC5164Hook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            address(ism).addressToBytes32(),
            address(0)
        );
    }

    function testTypes() public view {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.ID_AUTH_ISM));
        assertEq(ism.moduleType(), uint8(IInterchainSecurityModule.Types.NULL));
    }

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectEmit(false, true, true, true, address(dispatcher));
        emit MessageDispatched(
            messageId,
            address(hook),
            DESTINATION_DOMAIN,
            address(ism),
            _encodedHookData
        );
    }

    function test_verify_revertWhen_invalidMetadata() public override {
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    function test_postDispatch_revertWhen_msgValueNotAllowed() public payable {
        originMailbox.updateLatestDispatchedId(messageId);

        vm.expectRevert("ERC5164Hook: no value allowed");
        hook.postDispatch{value: 1}(bytes(""), encodedMessage);
    }

    // override to omit direct external bridge call
    function test_verify_revertsWhen_notAuthorizedHook() public override {
        vm.prank(alice);

        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ism.preVerifyMessage(messageId, 0);
        assertFalse(ism.isVerified(encodedMessage));
    }

    // SKIP - duplicate of test_verify_revertWhen_invalidMetadata
    function test_verify_revertsWhen_incorrectMessageId() public override {}

    function test_verify_revertsWhen_invalidIsm() public override {}

    // SKIP - 5164 ism does not support msg.value
    function test_verify_msgValue_asyncCall() public override {}

    function test_verify_msgValue_externalBridgeCall() public override {}

    function test_verify_valueAlreadyClaimed(uint256) public override {}

    function test_verify_override_msgValue() public override {}

    function testFuzz_postDispatch_refundsExtraValue(uint256) public override {}

    function test_verify_false_arbitraryCall() public override {}

    /* ============ helper functions ============ */

    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) internal override {
        vm.prank(address(executor));
        ism.preVerifyMessage(messageId, 0);
    }

    function _encodeExternalDestinationBridgeCall(
        address _from,
        address _to,
        uint256 _msgValue,
        bytes32 _messageId
    ) internal override returns (bytes memory) {
        if (_from == address(hook)) {
            vm.prank(address(executor));
            ism.preVerifyMessage{value: _msgValue}(messageId, 0);
        }
    }
}
