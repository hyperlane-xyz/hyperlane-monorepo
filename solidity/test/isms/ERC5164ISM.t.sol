// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

import {IMessageDispatcher} from "../../contracts/interfaces/IMessageDispatcher.sol";
import {ERC5164Hook} from "../../contracts/hooks/ERC5164Hook.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {ERC5164ISM} from "../../contracts/isms/hook/ERC5164ISM.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MockMessageDispatcher, MockMessageExecutor} from "../../contracts/mock/MockERC5164.sol";

contract ERC5164ISMTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    IMessageDispatcher internal dispatcher;
    MockMessageExecutor internal executor;

    ERC5164Hook internal hook;
    ERC5164ISM internal ism;
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
    }

    function deployContracts() public {
        ism = new ERC5164ISM(address(executor));
        address mailbox = address(0); // TODO: check?
        hook = new ERC5164Hook(
            mailbox,
            TEST2_DOMAIN,
            address(ism),
            address(dispatcher)
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                            TESTS                            ///
    ///////////////////////////////////////////////////////////////////

    function test_constructor() public {
        vm.expectRevert("ERC5164ISM: invalid executor");
        ism = new ERC5164ISM(alice);

        vm.expectRevert("MailboxClient: invalid mailbox");
        hook = new ERC5164Hook(
            address(0),
            0,
            address(ism),
            address(dispatcher)
        );

        vm.expectRevert("ERC5164Hook: invalid destination domain");
        hook = new ERC5164Hook(
            address(dispatcher),
            0,
            address(ism),
            address(dispatcher)
        );

        vm.expectRevert("ERC5164Hook: invalid ISM");
        hook = new ERC5164Hook(
            address(dispatcher),
            TEST2_DOMAIN,
            address(0),
            address(dispatcher)
        );

        vm.expectRevert("ERC5164Hook: invalid dispatcher");
        hook = new ERC5164Hook(
            address(dispatcher),
            TEST2_DOMAIN,
            address(ism),
            address(0)
        );
    }

    function test_postDispatch() public {
        deployContracts();

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

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

    function test_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployContracts();

        encodedMessage = _encodeTestMessage(0, address(this));

        vm.expectRevert("ERC5164Hook: invalid destination domain");
        hook.postDispatch(bytes(""), encodedMessage);
    }

    /* ============ ISM.verifyMessageId ============ */

    function test_verifyMessageId() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);
        assertTrue(ism.verifiedMessages(messageId));

        vm.stopPrank();
    }

    function test_verifyMessageId_RevertWhen_NotAuthorized() public {
        deployContracts();

        vm.startPrank(alice);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("ERC5164ISM: sender is not the executor");
        ism.verifyMessageId(messageId);

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function test_verify() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        vm.stopPrank();
    }

    function test_verify_RevertWhen_InvalidMessage() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = ism.verify(new bytes(0), invalidMessage);
        assertFalse(verified);

        vm.stopPrank();
    }

    function test_verify_RevertWhen_InvalidSender() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(messageId);

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertFalse(verified);

        vm.stopPrank();
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage(uint32 _msgCount, address _receipient)
        internal
        view
        returns (bytes memory)
    {
        return
            abi.encodePacked(
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
