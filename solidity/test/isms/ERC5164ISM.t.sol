// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

import {IMessageDispatcher} from "../../contracts/hooks/ERC5164/interfaces/IMessageDispatcher.sol";
import {ERC5164MessageHook} from "../../contracts/hooks/ERC5164/ERC5164MessageHook.sol";
import {ERC5164ISM} from "../../contracts/isms/hook/ERC5164ISM.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MockMessageDispatcher, MockMessageExecutor} from "../../contracts/mock/MockERC5164.sol";

contract ERC5164ISMTest is Test {
    using TypeCasts for address;

    IMessageDispatcher internal dispatcher;
    MockMessageExecutor internal executor;

    ERC5164MessageHook internal hook;
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
    bytes32 messageId = Message.id(encodedMessage);

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
        hook = new ERC5164MessageHook(
            TEST2_DOMAIN,
            address(dispatcher),
            address(ism)
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                            TESTS                            ///
    ///////////////////////////////////////////////////////////////////

    function test_constructor() public {
        vm.expectRevert("ERC5164ISM: invalid executor");
        ism = new ERC5164ISM(alice);

        vm.expectRevert("ERC5164Hook: invalid destination domain");
        hook = new ERC5164MessageHook(0, address(dispatcher), address(ism));

        vm.expectRevert("ERC5164Hook: invalid dispatcher");
        hook = new ERC5164MessageHook(TEST2_DOMAIN, alice, address(ism));

        vm.expectRevert("ERC5164Hook: invalid ISM");
        hook = new ERC5164MessageHook(
            TEST2_DOMAIN,
            address(dispatcher),
            address(0)
        );
    }

    function test_postDispatch() public {
        deployContracts();

        bytes memory encodedHookData = abi.encodeCall(
            ERC5164ISM.verifyMessageId,
            (address(this).addressToBytes32(), messageId)
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

        hook.postDispatch(TEST2_DOMAIN, messageId);
    }

    function test_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployContracts();

        vm.expectRevert("ERC5164Hook: invalid destination domain");
        hook.postDispatch(3, messageId);
    }

    /* ============ ISM.verifyMessageId ============ */

    function test_verifyMessageId() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(address(this).addressToBytes32(), messageId);
        assertTrue(
            ism.verifiedMessageIds(messageId, address(this).addressToBytes32())
        );

        vm.stopPrank();
    }

    function test_verifyMessageId_RevertWhen_NotAuthorized() public {
        deployContracts();

        vm.startPrank(alice);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("ERC5164ISM: sender is not the executor");
        ism.verifyMessageId(alice.addressToBytes32(), messageId);

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function test_verify() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(address(this).addressToBytes32(), messageId);

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        vm.stopPrank();
    }

    function test_verify_RevertWhen_InvalidMessage() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(address(this).addressToBytes32(), messageId);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = ism.verify(new bytes(0), invalidMessage);
        assertFalse(verified);

        vm.stopPrank();
    }

    function test_verify_RevertWhen_InvalidSender() public {
        deployContracts();

        vm.startPrank(address(executor));

        ism.verifyMessageId(alice.addressToBytes32(), messageId);

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
