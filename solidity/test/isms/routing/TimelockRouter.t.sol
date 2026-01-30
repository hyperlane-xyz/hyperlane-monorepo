// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TimelockRouter} from "../../../contracts/isms/routing/TimelockRouter.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {StandardHookMetadata} from "../../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IPostDispatchHook} from "../../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../../contracts/interfaces/IInterchainSecurityModule.sol";
import {HypERC20} from "../../../contracts/token/HypERC20.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {Message} from "../../../contracts/libs/Message.sol";

contract TimelockRouterTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    TimelockRouter public originRouter;
    TimelockRouter public destinationRouter;
    MockMailbox public originMailbox;
    MockMailbox public destinationMailbox;

    uint32 public constant ORIGIN_DOMAIN = 1;
    uint32 public constant DESTINATION_DOMAIN = 2;
    uint48 public constant TIMELOCK_WINDOW = 1 hours;

    bytes public metadata;
    bytes public testMessage;

    event MessageQueued(bytes32 indexed messageId, uint48 readyAt);

    function setUp() public {
        // Deploy mailboxes
        originMailbox = new MockMailbox(ORIGIN_DOMAIN);
        destinationMailbox = new MockMailbox(DESTINATION_DOMAIN);
        originMailbox.addRemoteMailbox(DESTINATION_DOMAIN, destinationMailbox);

        // Deploy routers
        originRouter = new TimelockRouter(
            address(originMailbox),
            TIMELOCK_WINDOW
        );
        destinationRouter = new TimelockRouter(
            address(destinationMailbox),
            TIMELOCK_WINDOW
        );

        // Enroll remote routers
        originRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destinationRouter).addressToBytes32()
        );
        destinationRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32()
        );

        // Create test message
        testMessage = originMailbox.buildMessage(
            address(this),
            DESTINATION_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("test body")
        );

        // Create standard metadata
        metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            address(this),
            bytes("")
        );
    }

    // ============ Hook Tests ============

    function test_hookType() public {
        assertEq(
            originRouter.hookType(),
            uint8(IPostDispatchHook.HookTypes.ROUTING)
        );
    }

    function test_supportsMetadata() public {
        assertTrue(originRouter.supportsMetadata(metadata));
        assertTrue(originRouter.supportsMetadata(bytes("")));
    }

    function test_postDispatch() public {
        bytes32 messageId = testMessage.id();
        uint256 fee = originRouter.quoteDispatch(metadata, testMessage);

        vm.deal(address(this), fee);

        // Post dispatch (sends message to destination)
        originRouter.postDispatch{value: fee}(metadata, testMessage);

        // Expect MessageQueued event when the destination router receives the message
        vm.expectEmit(true, true, true, true, address(destinationRouter));
        emit MessageQueued(
            messageId,
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );
        // Handle the message on destination router
        destinationMailbox.processNextInboundMessage();

        // Verify message readyAt is set correctly
        assertEq(
            destinationRouter.readyAt(messageId),
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );
    }

    function test_quoteDispatch(uint256 fee) public {
        TestPostDispatchHook customHook = new TestPostDispatchHook();
        customHook.setFee(fee);
        originRouter.setHook(address(customHook));
        uint256 quote = originRouter.quoteDispatch(metadata, testMessage);
        assertEq(quote, fee);
    }

    // ============ Router Tests ============

    function test_handle_preverifiesMessage() public {
        bytes32 messageId = keccak256("test-message-id");
        bytes memory payload = abi.encode(messageId);

        // Handle should preverify the message
        vm.expectEmit(true, true, true, true, address(destinationRouter));
        emit MessageQueued(
            messageId,
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );

        vm.prank(address(destinationMailbox));
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );

        assertEq(
            destinationRouter.readyAt(messageId),
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );
    }

    function test_handle_revertsOnDoublePreverification() public {
        bytes32 messageId = keccak256("test-message-id");
        bytes memory payload = abi.encode(messageId);

        // First preverification
        vm.startPrank(address(destinationMailbox));
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );

        // Second preverification should revert
        vm.expectRevert("TimelockRouter: message already preverified");
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );
    }

    // ============ ISM Tests ============

    function test_moduleType() public {
        assertEq(
            destinationRouter.moduleType(),
            uint8(IInterchainSecurityModule.Types.NULL)
        );
    }

    function test_verify_succeedsAfterOptimisticWindow() public {
        bytes32 messageId = testMessage.id();
        bytes memory payload = abi.encode(messageId);

        // Preverify the message
        vm.prank(address(destinationMailbox));
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );

        // Fast forward past the optimistic window
        vm.warp(block.timestamp + TIMELOCK_WINDOW);

        // Verify should succeed
        assertTrue(destinationRouter.verify(bytes(""), testMessage));
    }

    function test_verify_revertsBeforeOptimisticWindow() public {
        bytes32 messageId = testMessage.id();
        bytes memory payload = abi.encode(messageId);

        // Preverify the message
        vm.prank(address(destinationMailbox));
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );

        // Try to verify before window expires
        uint48 readyAt = uint48(block.timestamp) + TIMELOCK_WINDOW;
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockRouter.MessageNotReadyUntil.selector,
                readyAt
            )
        );
        destinationRouter.verify(bytes(""), testMessage);
    }

    function test_verify_revertsIfNotPreverified() public {
        vm.expectRevert("TimelockRouter: message not preverified");
        destinationRouter.verify(bytes(""), testMessage);
    }

    function test_verify_exactlyAtBoundary() public {
        bytes32 messageId = testMessage.id();
        bytes memory payload = abi.encode(messageId);

        // Preverify the message
        uint48 preverifiedAt = uint48(block.timestamp);
        vm.prank(address(destinationMailbox));
        destinationRouter.handle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            payload
        );

        // Fast forward to exactly the boundary
        vm.warp(preverifiedAt + TIMELOCK_WINDOW);

        // Verify should succeed at exactly the boundary
        assertTrue(destinationRouter.verify(bytes(""), testMessage));
    }

    // ============ Integration Tests ============

    function test_warpRouteFlow(uint256 amount) public {
        HypERC20 originTokenRouter = new HypERC20(
            18,
            1,
            1,
            address(originMailbox)
        );
        HypERC20 destinationTokenRouter = new HypERC20(
            18,
            1,
            1,
            address(destinationMailbox)
        );
        originTokenRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destinationTokenRouter).addressToBytes32()
        );
        destinationTokenRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originTokenRouter).addressToBytes32()
        );
        originTokenRouter.initialize(
            amount, // total supply
            "Hyperlane",
            "HYPER",
            address(originRouter), // hook
            address(originRouter), // ism
            address(this)
        );
        destinationTokenRouter.initialize(
            0,
            "Hyperlane",
            "HYPER",
            address(destinationRouter), // hook
            address(destinationRouter), // ism
            address(this)
        );

        // 1. transfer amount to self
        originTokenRouter.transferRemote(
            DESTINATION_DOMAIN,
            address(this).addressToBytes32(),
            amount
        );

        // 2. transfer message reverts while not preverified
        vm.expectRevert("TimelockRouter: message not preverified");
        destinationMailbox.processInboundMessage(1);

        // 3. process preverify message
        destinationMailbox.processInboundMessage(0);
        uint48 readyAt = uint48(block.timestamp) + TIMELOCK_WINDOW;

        // 4. transfer message reverts while timelock not ready
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockRouter.MessageNotReadyUntil.selector,
                readyAt
            )
        );
        destinationMailbox.processInboundMessage(1);

        // 5. transfer message processes when timelock ready
        vm.warp(block.timestamp + TIMELOCK_WINDOW);
        destinationMailbox.processInboundMessage(1);

        // 6. assert transfer amount delivered on destination
        assertEq(destinationTokenRouter.balanceOf(address(this)), amount);
    }
}
