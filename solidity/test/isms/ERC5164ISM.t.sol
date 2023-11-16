// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

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

contract ERC5164IsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for address;
    using Message for bytes;
    using MessageUtils for bytes;

    IMessageDispatcher internal dispatcher;
    MockMessageExecutor internal executor;

    ERC5164Hook internal hook;
    ERC5164Ism internal ism;
    TestMailbox internal originMailbox;
    TestRecipient internal testRecipient;

    uint32 internal constant TEST1_DOMAIN = 1;
    uint32 internal constant TEST2_DOMAIN = 2;

    uint8 internal constant VERSION = 0;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    address internal alice = address(0x1);

    // req for most tests
    bytes encodedMessage = _encodeTestMessage(0, address(testRecipient));
    bytes32 messageId = encodedMessage.id();

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

    function setUp() public {
        dispatcher = new MockMessageDispatcher();
        executor = new MockMessageExecutor();
        testRecipient = new TestRecipient();
        originMailbox = new TestMailbox(TEST1_DOMAIN);
        ism = new ERC5164Ism(address(executor));
        hook = new ERC5164Hook(
            address(originMailbox),
            TEST2_DOMAIN,
            address(ism).addressToBytes32(),
            address(dispatcher)
        );
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
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
            TEST2_DOMAIN,
            address(0).addressToBytes32(),
            address(dispatcher)
        );

        vm.expectRevert("ERC5164Hook: invalid dispatcher");
        hook = new ERC5164Hook(
            address(originMailbox),
            TEST2_DOMAIN,
            address(ism).addressToBytes32(),
            address(0)
        );
    }

    function test_postDispatch() public {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );
        originMailbox.updateLatestDispatchedId(messageId);

        // note: not checking for messageId since this is implementation dependent on each vendor
        vm.expectEmit(false, true, true, true, address(dispatcher));
        emit MessageDispatched(
            messageId,
            address(hook),
            TEST2_DOMAIN,
            address(ism),
            encodedHookData
        );

        hook.postDispatch(bytes(""), encodedMessage);
    }

    function testTypes() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.ID_AUTH_ISM));
        assertEq(ism.moduleType(), uint8(IInterchainSecurityModule.Types.NULL));
    }

    function test_postDispatch_RevertWhen_ChainIDNotSupported() public {
        encodedMessage = MessageUtils.formatMessage(
            VERSION,
            0,
            TEST1_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            3, // unsupported chain id
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
        originMailbox.updateLatestDispatchedId(Message.id(encodedMessage));

        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        hook.postDispatch(bytes(""), encodedMessage);
    }

    function test_postDispatch_RevertWhen_msgValueNotAllowed() public payable {
        originMailbox.updateLatestDispatchedId(messageId);

        vm.expectRevert("ERC5164Hook: no value allowed");
        hook.postDispatch{value: 1}(bytes(""), encodedMessage);
    }

    /* ============ ISM.verifyMessageId ============ */

    function test_verifyMessageId() public {
        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);
        assertTrue(ism.verifiedMessages(messageId).isBitSet(255));

        vm.stopPrank();
    }

    function test_verifyMessageId_RevertWhen_NotAuthorized() public {
        vm.startPrank(alice);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ism.verifyMessageId(messageId);

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function test_verify() public {
        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        vm.stopPrank();
    }

    function test_verify_RevertWhen_InvalidMessage() public {
        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = ism.verify(new bytes(0), invalidMessage);
        assertFalse(verified);

        vm.stopPrank();
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage(
        uint32 _msgCount,
        address _receipient
    ) internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                VERSION,
                _msgCount,
                TEST1_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                TEST2_DOMAIN,
                TypeCasts.addressToBytes32(_receipient),
                testMessage
            );
    }
}
