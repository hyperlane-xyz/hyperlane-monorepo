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
import {TvlRateLimited} from "../../contracts/libs/TvlRateLimited.sol";
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

        // 7. Warm up the mailboxes with a throwaway dispatch each.
        //    `DelayedFlowRouter` requires `message.nonce > lastCreditedNonce`,
        //    and a fresh `MockMailbox` starts at nonce 0 — real mailboxes
        //    have dispatched many messages before a router is deployed.
        //    Each warmup occupies `inboundMessages[0]` on the remote side;
        //    subsequent preverify/warp messages land at index 1/2.
        originMailbox.dispatch(DESTINATION_DOMAIN, bytes32(0), bytes("warmup"));
        destinationMailbox.dispatch(ORIGIN_DOMAIN, bytes32(0), bytes("warmup"));
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
        (
            HypNative nativeRouter,
            DelayedFlowRouter nativeDelay
        ) = _deployNativeDelay(INITIAL_COLLATERAL);
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

    // Delay-mode permits a 100% threshold (over-limit is delayed, not
    // reverted), unlike the reject-mode default.
    function test_thresholdBps_allows100Percent() public {
        DelayedFlowRouter full = new DelayedFlowRouter(
            TokenRouter(payable(address(collateralRouter))),
            10_000,
            MAX_DELAY
        );
        assertEq(full.thresholdBps(), 10_000);
    }

    function test_thresholdBps_revertsAbove100Percent() public {
        vm.expectRevert(TvlRateLimited.InvalidThresholdBps.selector);
        new DelayedFlowRouter(
            TokenRouter(payable(address(collateralRouter))),
            10_001,
            MAX_DELAY
        );
    }

    // ============ Happy path: under-threshold withdrawal ============

    function test_underThreshold_passesImmediately() public {
        uint256 amount = destinationDelay.maxCapacity() / 2; // well under
        bytes32 messageId = _dispatchWithdrawal(amount);

        // Index 0 is the setUp warmup; preverify lands at 1, warp at 2.
        destinationMailbox.processInboundMessage(1);

        assertEq(destinationDelay.readyAt(messageId), uint48(block.timestamp));

        destinationMailbox.processInboundMessage(2);

        assertEq(underlying.balanceOf(user), amount);
    }

    // ============ Over-threshold: scaled delay ============

    function test_overThreshold_delaysProportionally() public {
        uint256 cap = destinationDelay.maxCapacity();
        uint256 amount = cap + cap / 2; // 1.5x capacity
        bytes32 messageId = _dispatchWithdrawal(amount);

        destinationMailbox.processInboundMessage(1);

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
        destinationMailbox.processInboundMessage(2);

        // Fast-forward, then deliver
        vm.warp(block.timestamp + expectedWait);
        destinationMailbox.processInboundMessage(2);
        assertEq(underlying.balanceOf(user), amount);
    }

    function test_oversize_clipsAtMaxDelay() public {
        uint256 cap = destinationDelay.maxCapacity();
        bytes32 id = keccak256("oversize");
        _simulateWithdrawal(id, cap * 100);
        // Raw wait would be 100× DURATION; clipped to MAX_DELAY
        assertEq(
            destinationDelay.readyAt(id),
            uint48(block.timestamp + MAX_DELAY)
        );
    }

    /// @dev A raw `(amount - level) * DURATION` would overflow for a huge
    /// amount; `_consume` uses `mulDiv`, so it stays overflow-safe and the
    /// result clamps to `MAX_DELAY`.
    function test_hugeAmount_clampsToMaxDelayWithoutOverflow() public {
        bytes32 id = keccak256("huge");
        _simulateWithdrawal(id, type(uint256).max / 2);
        assertEq(
            destinationDelay.readyAt(id),
            uint48(block.timestamp + MAX_DELAY)
        );
    }

    /// @dev The bucket is in the destination token's local units, but the
    /// payload amount is in the route's scaled units. For any scale, the delay
    /// must be sized against the amount converted to local units by the
    /// router's scale. Uses a fresh scaled collateral route + DFR.
    function testFuzz_delaySizedInLocalUnits_forAnyScale(
        uint256 scaleNumerator,
        uint256 scaleDenominator,
        uint256 messageAmount
    ) public {
        scaleNumerator = bound(scaleNumerator, 1, 1e12);
        scaleDenominator = bound(scaleDenominator, 1, 1e12);

        HypERC20Collateral scaledRouter = new HypERC20Collateral(
            address(underlying),
            scaleNumerator,
            scaleDenominator,
            address(destinationMailbox)
        );
        underlying.mintTo(address(scaledRouter), INITIAL_COLLATERAL);
        DelayedFlowRouter scaledDelay = new DelayedFlowRouter(
            TokenRouter(payable(address(scaledRouter))),
            THRESHOLD_BPS,
            MAX_DELAY
        );
        scaledDelay.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32()
        );

        uint256 cap = scaledDelay.maxCapacity(); // local units

        // Cover both under- and over-capacity (up to ~3x cap local). Bounds
        // keep raw arithmetic equal to the contract's mulDiv(Rounding.Down).
        uint256 maxMessage = ((cap * 3) * scaleNumerator) / scaleDenominator;
        messageAmount = bound(messageAmount, 0, maxMessage);
        uint256 localAmount = (messageAmount * scaleDenominator) /
            scaleNumerator;

        bytes32 id = keccak256(abi.encode(messageAmount, cap));
        vm.prank(address(destinationMailbox));
        scaledDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            abi.encode(id, messageAmount)
        );

        // Expected delay derived from the LOCAL amount (mirrors _consume).
        uint256 expectedWait;
        if (localAmount > cap) {
            expectedWait = ((localAmount - cap) * scaledDelay.DURATION()) / cap;
            if (expectedWait > MAX_DELAY) expectedWait = MAX_DELAY;
        }
        assertEq(
            scaledDelay.readyAt(id),
            uint48(block.timestamp + expectedWait)
        );
    }

    /// @dev The origin credit path (`_TimelockRouter_onDispatch`) must also
    /// meter local units. Drains a scaled route to zero via a consume, then
    /// credits via a direct postDispatch and asserts the bucket rose by the
    /// message amount converted to local units.
    function testFuzz_creditMetersLocalUnits_forAnyScale(
        uint256 scaleNumerator,
        uint256 scaleDenominator,
        uint256 creditMessage
    ) public {
        scaleNumerator = bound(scaleNumerator, 1, 1e12);
        scaleDenominator = bound(scaleDenominator, 1, 1e12);

        HypERC20Collateral scaledRouter = new HypERC20Collateral(
            address(underlying),
            scaleNumerator,
            scaleDenominator,
            address(destinationMailbox)
        );
        underlying.mintTo(address(scaledRouter), INITIAL_COLLATERAL);
        DelayedFlowRouter scaledDelay = new DelayedFlowRouter(
            TokenRouter(payable(address(scaledRouter))),
            THRESHOLD_BPS,
            MAX_DELAY
        );
        scaledDelay.enrollRemoteRouter(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32()
        );

        uint256 cap = scaledDelay.maxCapacity();

        // Over-drain (>capacity) so `_consume` clamps the level to zero
        // regardless of scale rounding.
        vm.prank(address(destinationMailbox));
        scaledDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            abi.encode(
                keccak256("drain"),
                (cap * 2 * scaleNumerator) / scaleDenominator
            )
        );
        assertEq(scaledDelay.calculateCurrentLevel(), 0);

        // Credit a local amount within capacity (no clamp) so the delta is
        // exact.
        creditMessage = bound(
            creditMessage,
            0,
            (cap * scaleNumerator) / scaleDenominator
        );

        {
            bytes memory message = MessageUtils.formatMessage(
                3,
                1, // nonce > lastCreditedNonce (0)
                DESTINATION_DOMAIN,
                address(scaledRouter).addressToBytes32(),
                ORIGIN_DOMAIN,
                address(originDelay).addressToBytes32(),
                TokenMessage.format(
                    user.addressToBytes32(),
                    creditMessage,
                    bytes("")
                )
            );
            vm.mockCall(
                address(destinationMailbox),
                abi.encodeWithSignature("latestDispatchedId()"),
                abi.encode(keccak256(message))
            );
            scaledDelay.postDispatch(bytes(""), message);
        }

        assertEq(
            scaledDelay.calculateCurrentLevel(),
            (creditMessage * scaleDenominator) / scaleNumerator
        );
    }

    // ============ Deposit replenishment ============

    function test_depositCreditsBucket() public {
        uint256 cap = destinationDelay.maxCapacity();
        uint256 amount = cap / 4;

        // Drain bucket first.
        _simulateWithdrawal(keccak256("drain"), cap + 1);
        assertEq(destinationDelay.filledLevel(), 0);

        // Local deposit on collateral chain credits destinationDelay's
        // bucket via its postDispatch.
        _deposit(amount);
        assertEq(destinationDelay.filledLevel(), amount);
    }

    // ============ Replay prevention ============

    function test_postDispatch_advancesLastCreditedNonce() public {
        _dispatchWithdrawal(1 ether);
        assertGt(originDelay.lastCreditedNonce(), 0);
    }

    function test_postDispatch_revertsIfNotLatestDispatched() public {
        // Craft a valid-looking warp message that was never dispatched
        // through the Mailbox. Sender + nonce checks pass, but
        // `_isLatestDispatched` rejects it.
        uint32 fakeNonce = originDelay.lastCreditedNonce() + 1;
        bytes memory message = MessageUtils.formatMessage(
            3,
            fakeNonce,
            ORIGIN_DOMAIN,
            address(syntheticRouter).addressToBytes32(),
            DESTINATION_DOMAIN,
            address(collateralRouter).addressToBytes32(),
            TokenMessage.format(user.addressToBytes32(), 1 ether, bytes(""))
        );
        vm.expectRevert("message not dispatching");
        originDelay.postDispatch(bytes(""), message);
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
        // Craft a message whose sender is NOT the paired warp router. Make it
        // the latest dispatched so `postDispatch`'s `_isLatestDispatched`
        // guard passes and execution reaches the sender check.
        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            makeAddr("imposter"),
            DESTINATION_DOMAIN,
            address(collateralRouter),
            1 ether
        );
        _mockLatestDispatched(message);
        vm.expectRevert(
            abi.encodeWithSelector(
                DelayedFlowRouter.WrongSender.selector,
                makeAddr("imposter")
            )
        );
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
        vm.expectRevert(
            abi.encodeWithSelector(
                DelayedFlowRouter.WrongRecipient.selector,
                makeAddr("imposter")
            )
        );
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

    // ============ setRefillRate override ============

    /// @dev Capacity is derived dynamically, so the inherited `setRefillRate`
    /// would write a dead slot. The override rejects it outright.
    function test_setRefillRate_reverts() public {
        vm.expectRevert(TvlRateLimited.UseThresholdBps.selector);
        destinationDelay.setRefillRate(1 ether);
    }

    // ============ Replay guard on origin ============

    /// @dev A second `postDispatch` carrying a nonce that has already been
    /// credited is rejected, even from the paired warp router.
    function test_postDispatch_revertsWhenAlreadyCredited() public {
        // A real dispatch advances `lastCreditedNonce` past 0.
        _dispatchWithdrawal(1 ether);
        assertGt(originDelay.lastCreditedNonce(), 0);

        // `_makeMessage` builds a nonce-0 message from the paired warp router,
        // which clears the sender check but trips the replay guard. Make it
        // the latest dispatched so `postDispatch` reaches that guard.
        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            address(syntheticRouter),
            DESTINATION_DOMAIN,
            address(collateralRouter),
            1 ether
        );
        _mockLatestDispatched(message);
        vm.expectRevert(
            abi.encodeWithSelector(
                DelayedFlowRouter.AlreadyCredited.selector,
                uint32(0)
            )
        );
        originDelay.postDispatch(bytes(""), message);
    }

    // ============ quoteDispatch override ============

    /// @dev The `(id, amount)` payload override still routes the quote to the
    /// configured hook, returning its fee unchanged.
    function test_quoteDispatch_matchesConfiguredHook(uint256 fee) public {
        TestPostDispatchHook customHook = new TestPostDispatchHook();
        customHook.setFee(fee);
        originDelay.setHook(address(customHook));

        bytes memory message = _makeMessage(
            ORIGIN_DOMAIN,
            address(syntheticRouter),
            DESTINATION_DOMAIN,
            address(collateralRouter),
            1 ether
        );
        assertEq(originDelay.quoteDispatch(bytes(""), message), fee);
    }

    // ============ Fuzz: net flow invariants ============

    /// @dev For any withdrawal amount on destination, the committed wait is
    /// zero iff `amount <= currentLevel`, otherwise strictly positive and
    /// clamped to `maxDelay`.
    function testFuzz_withdraw_waitInvariants(uint128 _amount) public {
        vm.assume(_amount > 0);
        uint256 amount = uint256(_amount);

        bytes32 id = keccak256(abi.encode("fuzz-withdraw", amount));
        uint256 levelBefore = destinationDelay.calculateCurrentLevel();
        _simulateWithdrawal(id, amount);

        uint48 readyAt = destinationDelay.readyAt(id);
        uint48 wait = readyAt - uint48(block.timestamp);
        assertLe(wait, MAX_DELAY, "wait exceeds maxDelay");
        // Under-threshold is always instant; over-threshold may floor to 0
        // via integer division for tiny overages (Math.mulDiv rounds down).
        if (amount <= levelBefore) {
            assertEq(wait, 0, "under-threshold must be instant");
        }
    }

    /// @dev Sequence of alternating withdrawals and deposits. Asserts that
    /// the bucket never exceeds `maxCapacity()`, is bounded below by zero,
    /// and that each committed wait is within `[0, maxDelay]`.
    function testFuzz_sequence_invariants(uint128[8] memory _amounts) public {
        for (uint256 i = 0; i < _amounts.length; i++) {
            uint256 cap = destinationDelay.maxCapacity();
            uint256 amount = bound(uint256(_amounts[i]), 1, cap);

            if (i % 2 == 0) {
                // Inbound withdrawal → consume bucket.
                bytes32 id = keccak256(abi.encode("fuzz-seq", i));
                uint256 levelBefore = destinationDelay.calculateCurrentLevel();
                _simulateWithdrawal(id, amount);
                uint48 wait = destinationDelay.readyAt(id) -
                    uint48(block.timestamp);
                assertLe(wait, MAX_DELAY, "wait exceeds maxDelay");
                // Under-threshold is always instant; over-threshold may
                // still floor to 0 via integer division for small overages.
                if (amount <= levelBefore) {
                    assertEq(wait, 0);
                }
            } else {
                // Outbound deposit → credit bucket.
                _deposit(amount);
            }

            assertLe(
                destinationDelay.filledLevel(),
                destinationDelay.maxCapacity(),
                "bucket > cap"
            );
        }
    }

    // ============ Rebalancing ============

    /// @dev After a full drain, a rebalancer depositing the same amount
    /// restores instant UX for the next same-sized withdrawal.
    function test_rebalancing_restoresInstantUX() public {
        uint256 cap = destinationDelay.maxCapacity();

        // 1. User A drains the bucket + enough overage to produce a
        //    measurable delay (small overages floor to 0 via integer
        //    division on the rate).
        bytes32 idA = keccak256("user-A");
        _simulateWithdrawal(idA, cap + cap / 2);
        assertEq(destinationDelay.filledLevel(), 0);
        assertGt(
            destinationDelay.readyAt(idA) - uint48(block.timestamp),
            0,
            "A should be delayed"
        );

        // 2. Rebalancer deposits `cap` (collateral → synthetic dispatch).
        _deposit(cap);
        assertEq(
            destinationDelay.filledLevel(),
            cap,
            "bucket should be refilled"
        );

        // 3. User B can now withdraw `cap` with no wait.
        bytes32 idB = keccak256("user-B");
        _simulateWithdrawal(idB, cap);
        assertEq(
            destinationDelay.readyAt(idB),
            uint48(block.timestamp),
            "B should be instant"
        );
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
        destinationMailbox.processInboundMessage(1);

        // AggregationIsmMetadata format: 2 (start,end) u32 pairs. Both ISMs
        // ignore metadata, so empty ranges pointing past the header work.
        // Header is 2 ISMs × 2 × 4 bytes = 16 bytes.
        bytes memory aggMetadata = abi.encodePacked(
            uint32(16),
            uint32(16),
            uint32(16),
            uint32(16)
        );
        destinationMailbox.addInboundMetadata(2, aggMetadata);

        // Pause → aggregation verify reverts with Pausable's error
        pausable.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        destinationMailbox.processInboundMessage(2);

        // Unpause → delivers
        pausable.unpause();
        destinationMailbox.processInboundMessage(2);
        assertEq(underlying.balanceOf(user), amount);
    }

    // ============ Helpers ============

    function _simulateWithdrawal(bytes32 _id, uint256 _amount) internal {
        vm.prank(address(destinationMailbox));
        destinationDelay.handle(
            ORIGIN_DOMAIN,
            address(originDelay).addressToBytes32(),
            abi.encode(_id, _amount)
        );
    }

    function _deposit(uint256 _amount) internal {
        underlying.mintTo(address(this), _amount);
        underlying.approve(address(collateralRouter), _amount);
        vm.deal(address(this), 1 ether);
        collateralRouter.transferRemote{value: 1 ether}(
            ORIGIN_DOMAIN,
            address(this).addressToBytes32(),
            _amount
        );
    }

    function _deployNativeDelay(
        uint256 fund
    ) internal returns (HypNative, DelayedFlowRouter) {
        HypNative nativeRouter = new HypNative(
            1,
            1,
            address(destinationMailbox)
        );
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

    /// @dev Force the origin mailbox to report `message` as the latest
    /// dispatched id, so `postDispatch`'s `_isLatestDispatched` guard passes
    /// and execution reaches the subclass sender / replay checks.
    function _mockLatestDispatched(bytes memory message) internal {
        vm.mockCall(
            address(originMailbox),
            abi.encodeWithSignature("latestDispatchedId()"),
            abi.encode(keccak256(message))
        );
    }

    receive() external payable {}
}
