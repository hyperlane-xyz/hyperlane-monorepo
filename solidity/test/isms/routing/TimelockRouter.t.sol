// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TimelockRouter} from "../../../contracts/isms/routing/TimelockRouter.sol";
import {TestMailbox} from "../../../contracts/test/TestMailbox.sol";
import {StandardHookMetadata} from "../../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IPostDispatchHook} from "../../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../../contracts/interfaces/IInterchainSecurityModule.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {Message} from "../../../contracts/libs/Message.sol";

contract TimelockRouterTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    TimelockRouter public originRouter;
    TimelockRouter public destinationRouter;
    TestMailbox public originMailbox;
    TestMailbox public destinationMailbox;

    uint32 public constant ORIGIN_DOMAIN = 1;
    uint32 public constant DESTINATION_DOMAIN = 2;
    uint48 public constant TIMELOCK_WINDOW = 1 hours;

    bytes public metadata;
    bytes public testMessage;

    event MessageQueued(bytes32 indexed messageId, uint48 readyAt);

    function setUp() public {
        // Deploy mailboxes
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        destinationMailbox = new TestMailbox(DESTINATION_DOMAIN);

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
        testMessage = originMailbox.buildOutboundMessage(
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
            uint8(IPostDispatchHook.HookTypes.ID_AUTH_ISM)
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

        // Expect MessageQueued event when the destination router receives the message
        vm.expectEmit(true, true, true, true, address(destinationRouter));
        emit MessageQueued(
            messageId,
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );

        // Post dispatch (sends message to destination)
        originRouter.postDispatch{value: fee}(metadata, testMessage);

        // Process the message on destination
        bytes32 originRouterBytes32 = address(originRouter).addressToBytes32();
        bytes32 destinationRouterBytes32 = address(destinationRouter)
            .addressToBytes32();

        // Get the dispatched message
        bytes memory dispatchedMessage = destinationMailbox
            .buildOutboundMessage(
                DESTINATION_DOMAIN,
                destinationRouterBytes32,
                abi.encode(messageId)
            );

        // Handle the message on destination router
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            originRouterBytes32,
            destinationRouterBytes32,
            abi.encode(messageId)
        );

        // Verify message readyAt is set correctly
        assertEq(
            destinationRouter.readyAt(messageId),
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );
    }

    function test_quoteDispatch() public {
        uint256 quote = originRouter.quoteDispatch(metadata, testMessage);
        assertTrue(quote > 0, "Quote should be non-zero");
    }

    function test_postDispatch_revertsOnInvalidMetadata() public {
        bytes memory invalidMetadata = abi.encodePacked(
            uint16(0xFFFF),
            uint256(0)
        );

        vm.expectRevert("TimelockRouter: invalid metadata variant");
        originRouter.postDispatch(invalidMetadata, testMessage);
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

        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
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
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
            payload
        );

        // Second preverification should revert
        vm.expectRevert("TimelockRouter: message already preverified");
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
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
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
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
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
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
        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            address(originRouter).addressToBytes32(),
            address(destinationRouter).addressToBytes32(),
            payload
        );

        // Fast forward to exactly the boundary
        vm.warp(preverifiedAt + TIMELOCK_WINDOW);

        // Verify should succeed at exactly the boundary
        assertTrue(destinationRouter.verify(bytes(""), testMessage));
    }

    // ============ Owner Functions Tests ============

    function test_manuallyPreverifyMessage() public {
        bytes32 messageId = keccak256("manual-message-id");

        vm.expectEmit(true, true, true, true, address(destinationRouter));
        emit MessageQueued(
            messageId,
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );

        destinationRouter.manuallyPreverifyMessage(messageId);

        assertEq(
            destinationRouter.readyAt(messageId),
            uint48(block.timestamp) + TIMELOCK_WINDOW
        );
    }

    function test_manuallyPreverifyMessage_revertsIfAlreadyPreverified()
        public
    {
        bytes32 messageId = keccak256("manual-message-id");

        destinationRouter.manuallyPreverifyMessage(messageId);

        vm.expectRevert("TimelockRouter: message already preverified");
        destinationRouter.manuallyPreverifyMessage(messageId);
    }

    function test_manuallyPreverifyMessage_onlyOwner() public {
        bytes32 messageId = keccak256("manual-message-id");

        vm.prank(address(0x9999));
        vm.expectRevert("Ownable: caller is not the owner");
        destinationRouter.manuallyPreverifyMessage(messageId);
    }

    // ============ Integration Tests ============

    function test_fullFlow() public {
        bytes32 messageId = testMessage.id();
        uint256 fee = originRouter.quoteDispatch(metadata, testMessage);

        vm.deal(address(this), fee);

        // 1. Post dispatch on origin
        originRouter.postDispatch{value: fee}(metadata, testMessage);

        // 2. Handle message on destination
        bytes32 originRouterBytes32 = address(originRouter).addressToBytes32();
        bytes32 destinationRouterBytes32 = address(destinationRouter)
            .addressToBytes32();

        destinationMailbox.testHandle(
            ORIGIN_DOMAIN,
            originRouterBytes32,
            destinationRouterBytes32,
            abi.encode(messageId)
        );

        // 3. Verify message is preverified but not ready yet
        uint48 readyAt = uint48(block.timestamp) + TIMELOCK_WINDOW;
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockRouter.MessageNotReadyUntil.selector,
                readyAt
            )
        );
        destinationRouter.verify(bytes(""), testMessage);

        // 4. Fast forward past optimistic window
        vm.warp(block.timestamp + TIMELOCK_WINDOW);

        // 5. Verify message succeeds
        assertTrue(destinationRouter.verify(bytes(""), testMessage));
    }
}
