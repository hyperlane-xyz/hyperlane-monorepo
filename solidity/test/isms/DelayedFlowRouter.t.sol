// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {DelayedFlowRouter} from "../../contracts/isms/warp-route/DelayedFlowRouter.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {PausableIsm} from "../../contracts/isms/PausableIsm.sol";
import {StaticAggregationIsmFactory} from "../../contracts/isms/aggregation/StaticAggregationIsmFactory.sol";
import {TimelockRouter} from "../../contracts/isms/routing/TimelockRouter.sol";
import {MessageUtils} from "./IsmTestUtils.sol";

contract DelayedFlowRouterTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    uint32 constant ORIGIN_DOMAIN = 1;
    uint32 constant DESTINATION_DOMAIN = 2;
    uint256 constant THRESHOLD_BPS = 1000; // 10%
    uint48 constant REFILL_WINDOW = 1 days;
    uint48 constant MAX_DELAY = 1 days;
    uint256 constant INITIAL_COLLATERAL = 1_000_000 ether;

    MockMailbox originMailbox;
    MockMailbox destinationMailbox;

    ERC20Test underlying;
    HypERC20 syntheticRouter;
    HypERC20Collateral collateralRouter;

    DelayedFlowRouter originDelay;
    DelayedFlowRouter destinationDelay;

    address user = makeAddr("user");

    event Queued(bytes32 indexed messageId, uint256 amount, uint48 readyAt);
    event Credited(uint256 amount, uint256 newLevel);

    function setUp() public {
        originMailbox = new MockMailbox(ORIGIN_DOMAIN);
        destinationMailbox = new MockMailbox(DESTINATION_DOMAIN);
        originMailbox.addRemoteMailbox(DESTINATION_DOMAIN, destinationMailbox);
        destinationMailbox.addRemoteMailbox(ORIGIN_DOMAIN, originMailbox);

        // 1. Deploy warp routers (uninitialized)
        underlying = new ERC20Test("underlying", "UND", 0, 18);
        collateralRouter = new HypERC20Collateral(
            address(underlying),
            1,
            1,
            address(destinationMailbox)
        );
        syntheticRouter = new HypERC20(18, 1, 1, address(originMailbox));

        // 2. Fund pools BEFORE deploying DelayedFlowRouters so their
        //    constructors read a non-zero capacity base and bootstrap the
        //    bucket at maxCapacity.
        underlying.mintTo(address(collateralRouter), INITIAL_COLLATERAL);
        syntheticRouter.initialize(
            INITIAL_COLLATERAL,
            "synthetic",
            "SYN",
            address(0),
            address(0),
            address(this)
        );
        collateralRouter.initialize(address(0), address(0), address(this));

        // 3. Deploy DelayedFlowRouters (bucket bootstraps to maxCapacity)
        originDelay = new DelayedFlowRouter(
            TokenRouter(payable(address(syntheticRouter))),
            THRESHOLD_BPS,
            MAX_DELAY
        );
        destinationDelay = new DelayedFlowRouter(
            TokenRouter(payable(address(collateralRouter))),
            THRESHOLD_BPS,
            MAX_DELAY
        );

        // 4. Wire delay routers as hook + ISM
        syntheticRouter.setHook(address(originDelay));
        syntheticRouter.setInterchainSecurityModule(address(originDelay));
        collateralRouter.setHook(address(destinationDelay));
        collateralRouter.setInterchainSecurityModule(address(destinationDelay));

        // 5. Cross-enroll
        syntheticRouter.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(collateralRouter).addressToBytes32()
        );
        collateralRouter.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(syntheticRouter).addressToBytes32()
        );
        originDelay.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(destinationDelay).addressToBytes32()
        );
        destinationDelay.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32()
        );

        // 6. Fund user with synthetic for transferRemote burns
        syntheticRouter.transfer(user, INITIAL_COLLATERAL);
    }

    // ============ Capacity source derivation ============

    function test_capacitySourceDerivation() public {
        // HypERC20Collateral: token() returns the underlying → TOKEN_BALANCE
        assertEq(destinationDelay.capacityToken(), address(underlying));

        // HypERC20: token() returns self → TOKEN_SUPPLY
        assertEq(originDelay.capacityToken(), address(syntheticRouter));

        // HypNative: token() returns address(0) → NATIVE_BALANCE
        (, DelayedFlowRouter nativeDelay) = _deployNativeDelay(
            INITIAL_COLLATERAL
        );
        assertEq(nativeDelay.capacityToken(), address(0));
    }

    function test_maxCapacity_tracksCollateralBalance() public {
        uint256 cap = destinationDelay.maxCapacity();
        assertEq(cap, (INITIAL_COLLATERAL * THRESHOLD_BPS) / 10_000);
    }

    function test_maxCapacity_tracksNativeBalance() public {
        (HypNative nativeRouter, DelayedFlowRouter nativeDelay) = _deployNativeDelay(
            INITIAL_COLLATERAL
        );
        assertEq(
            nativeDelay.maxCapacity(),
            (INITIAL_COLLATERAL * THRESHOLD_BPS) / 10_000
        );
        // Dynamic: extra ETH into the pool grows the bucket ceiling.
        vm.deal(address(nativeRouter), INITIAL_COLLATERAL * 2);
        assertEq(
            nativeDelay.maxCapacity(),
            (INITIAL_COLLATERAL * 2 * THRESHOLD_BPS) / 10_000
        );
    }

    // ============ Happy path: under-threshold withdrawal ============

    function test_underThreshold_passesImmediately() public {
        uint256 amount = destinationDelay.maxCapacity() / 2; // well under
        bytes32 messageId = _dispatchWithdrawal(amount);

        // Preverify message arrives first (nonce 0), then warp message (nonce 1)
        destinationMailbox.processInboundMessage(0);

        assertEq(destinationDelay.readyAt(messageId), uint48(block.timestamp));

        // Warp message delivers in the same block (no delay)
        destinationMailbox.processInboundMessage(1);

        assertEq(underlying.balanceOf(user), amount);
    }

    // ============ Over-threshold: scaled delay ============

    function test_overThreshold_delaysProportionally() public {
        uint256 cap = destinationDelay.maxCapacity();
        uint256 amount = cap + cap / 2; // 1.5x capacity
        bytes32 messageId = _dispatchWithdrawal(amount);

        destinationMailbox.processInboundMessage(0);

        // Rate derived the same way as RateLimited._consume
        uint256 rate = cap / destinationDelay.DURATION();
        uint256 expectedWait = (amount - cap) / rate;
        if (expectedWait > MAX_DELAY) expectedWait = MAX_DELAY;

        assertEq(
            destinationDelay.readyAt(messageId),
            uint48(block.timestamp + expectedWait)
        );

        // Verify before readyAt: revert
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockRouter.MessageNotReadyUntil.selector,
                uint48(block.timestamp + expectedWait)
            )
        );
        destinationMailbox.processInboundMessage(1);

        // Fast-forward, then deliver
        vm.warp(block.timestamp + expectedWait);
        destinationMailbox.processInboundMessage(1);
        assertEq(underlying.balanceOf(user), amount);
    }

    function test_oversize_clipsAtMaxDelay() public {
        // Call _handle directly (user doesn't hold billions of tokens to burn)
        uint256 cap = destinationDelay.maxCapacity();
        uint256 huge = cap * 100;
        bytes32 id = keccak256("oversize");
        bytes memory payload = abi.encode(id, huge);

        vm.prank(address(destinationMailbox));
        destinationDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            payload
        );

        // Raw wait would be 100× DURATION; clipped to MAX_DELAY
        assertEq(
            destinationDelay.readyAt(id),
            uint48(block.timestamp + MAX_DELAY)
        );
    }

    // ============ Deposit replenishment ============

    function test_depositCreditsBucket() public {
        uint256 cap = destinationDelay.maxCapacity();
        uint256 amount = cap / 4;

        // Drain bucket first
        _dispatchWithdrawal(cap + 1);
        destinationMailbox.processInboundMessage(0);
        assertEq(destinationDelay.filledLevel(), 0);

        // Local deposit on collateral chain credits destinationDelay's
        // bucket via its postDispatch (local, no preverify enforcement on
        // origin side here — origin is just synthetic).
        underlying.mintTo(address(this), amount);
        underlying.approve(address(collateralRouter), amount);
        vm.deal(address(this), 1 ether);
        collateralRouter.transferRemote{value: 1 ether}(
            ORIGIN_DOMAIN,
            address(this).addressToBytes32(),
            amount
        );

        assertEq(destinationDelay.filledLevel(), amount);
    }

    // ============ Replay prevention ============

    function test_postDispatch_advancesNextDispatchNonce() public {
        uint32 before = originDelay.nextDispatchNonce();
        _dispatchWithdrawal(1 ether);
        assertEq(originDelay.nextDispatchNonce(), before + 1);
    }

    function test_handle_doublePreverifyReverts() public {
        bytes32 id = keccak256("fake");
        bytes memory payload = abi.encode(id, uint256(1 ether));

        vm.prank(address(destinationMailbox));
        destinationDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            payload
        );

        vm.expectRevert("TimelockRouter: message already preverified");
        vm.prank(address(destinationMailbox));
        destinationDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            payload
        );
    }

    // ============ Sender / recipient binding ============

    function test_postDispatch_revertsForWrongSender() public {
        // Craft a message whose sender is NOT the paired warp router.
        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            makeAddr("imposter"),
            DESTINATION_DOMAIN,
            address(collateralRouter),
            1 ether
        );
        vm.expectRevert("DelayedFlowRouter: wrong sender");
        originDelay.postDispatch(bytes(""), message);
    }

    function test_verify_revertsForWrongRecipient() public {
        // Recipient is not the paired warp router — verify must reject
        // before any readyAt lookup.
        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            address(syntheticRouter),
            DESTINATION_DOMAIN,
            makeAddr("imposter"),
            1 ether
        );
        vm.expectRevert("DelayedFlowRouter: wrong recipient");
        destinationDelay.verify(bytes(""), message);
    }

    // ============ verify guard ============

    function test_verify_revertsWhenNotPreverified() public {
        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            address(syntheticRouter),
            DESTINATION_DOMAIN,
            address(collateralRouter),
            1 ether
        );
        vm.expectRevert("TimelockRouter: message not preverified");
        destinationDelay.verify(bytes(""), message);
    }

    // ============ Aggregation with PausableIsm ============

    function test_pausable_blocksReadyMessage() public {
        // Deploy aggregation of [PausableIsm, DelayedFlowRouter] w/ threshold=2.
        // Order matters: PausableIsm first so a paused state short-circuits
        // the aggregation with `Pausable: paused` rather than whatever the
        // delay ISM would surface.
        PausableIsm pausable = new PausableIsm(address(this));
        StaticAggregationIsmFactory factory = new StaticAggregationIsmFactory();
        address[] memory modules = new address[](2);
        modules[0] = address(pausable);
        modules[1] = address(destinationDelay);
        address aggregation = factory.deploy(modules, 2);

        collateralRouter.setInterchainSecurityModule(aggregation);

        uint256 amount = destinationDelay.maxCapacity() / 2;
        _dispatchWithdrawal(amount);
        destinationMailbox.processInboundMessage(0);

        // AggregationIsmMetadata format: 2 (start,end) u32 pairs. Both ISMs
        // ignore metadata, so empty ranges pointing past the header work.
        // Header is 2 ISMs × 2 × 4 bytes = 16 bytes.
        bytes memory aggMetadata = abi.encodePacked(
            uint32(16),
            uint32(16),
            uint32(16),
            uint32(16)
        );
        destinationMailbox.addInboundMetadata(1, aggMetadata);

        // Pause → aggregation verify reverts with Pausable's error
        pausable.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        destinationMailbox.processInboundMessage(1);

        // Unpause → delivers
        pausable.unpause();
        destinationMailbox.processInboundMessage(1);
        assertEq(underlying.balanceOf(user), amount);
    }

    // ============ Helpers ============

    function _deployNativeDelay(
        uint256 fund
    ) internal returns (HypNative, DelayedFlowRouter) {
        HypNative nativeRouter = new HypNative(1, 1, address(destinationMailbox));
        vm.deal(address(nativeRouter), fund);
        nativeRouter.initialize(address(0), address(0), address(this));
        DelayedFlowRouter nativeDelay = new DelayedFlowRouter(
            TokenRouter(payable(address(nativeRouter))),
            THRESHOLD_BPS,
            MAX_DELAY
        );
        return (nativeRouter, nativeDelay);
    }

    function _dispatchWithdrawal(uint256 amount) internal returns (bytes32) {
        vm.deal(user, 10 ether);
        vm.prank(user);
        return
            syntheticRouter.transferRemote{value: 1 ether}(
                DESTINATION_DOMAIN,
                user.addressToBytes32(),
                amount
            );
    }

    function _findWarpMessageId() internal view returns (bytes32) {
        // Warp message is the second inbound message (nonce 1)
        bytes memory m = destinationMailbox.inboundMessages(1);
        return keccak256(m);
    }

    function _makeMessage(
        uint32 originDomain,
        address sender,
        uint32 destinationDomain,
        address recipient,
        uint256 amount
    ) internal pure returns (bytes memory) {
        bytes memory body = TokenMessage.format(
            recipient.addressToBytes32(),
            amount,
            bytes("")
        );
        return
            MessageUtils.formatMessage(
                3,
                0,
                originDomain,
                sender.addressToBytes32(),
                destinationDomain,
                recipient.addressToBytes32(),
                body
            );
    }

    receive() external payable {}
}
