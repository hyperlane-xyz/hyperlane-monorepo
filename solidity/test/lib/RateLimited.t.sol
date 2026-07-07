// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {RateLimited} from "../../contracts/libs/RateLimited.sol";

contract TestRateLimited is RateLimited {
    constructor(uint256 _maxCapacity) RateLimited(_maxCapacity) {}

    function validateAndConsumeFilledLevel(
        uint256 _amount
    ) public returns (uint256) {
        return _validateAndConsumeFilledLevel(_amount);
    }
}

/// @dev The real `RateLimited` with a settable, dynamic `maxCapacity()` and
/// deferred initialization — stands in for a `TvlRateLimited` subclass so the
/// bucket behavior can be driven directly through the public interface. Only
/// the capacity source and init state are overridden; all bucket math is the
/// shipped code.
contract DynamicRateLimited is RateLimited {
    uint256 private _capacity;
    bool private _initialized;

    constructor() RateLimited(0) {}

    function setCapacity(uint256 _c) external {
        _capacity = _c;
    }

    function maxCapacity() public view override returns (uint256) {
        return _capacity;
    }

    function _RateLimited_isInitialized()
        internal
        view
        override
        returns (bool)
    {
        return _initialized;
    }

    function _RateLimited_initialize() internal override {
        _initialized = true;
    }

    /// @dev Exposes the internal init hook so tests can assert on it.
    function isInitialized() external view returns (bool) {
        return _RateLimited_isInitialized();
    }

    function consume(uint256 _amount) external returns (uint256) {
        return _validateAndConsumeFilledLevel(_amount);
    }

    function credit(uint256 _amount) external returns (uint256) {
        return _credit(_amount);
    }

    function softConsume(uint256 _amount) external returns (uint256) {
        return _consume(_amount);
    }
}

contract RateLimitLibTest is Test {
    TestRateLimited rateLimited;
    uint256 constant MAX_CAPACITY = 1 ether;
    uint256 constant ONE_PERCENT = 0.01 ether; // Used for assertApproxEqRel
    address HOOK = makeAddr("HOOK");

    function setUp() public {
        rateLimited = new TestRateLimited(MAX_CAPACITY);
    }

    function testConstructor_revertsWhen_lowCapacity() public {
        vm.expectRevert("Capacity must be greater than DURATION");
        new RateLimited(1 days - 1);
    }

    function testRateLimited_setsNewLimit() external {
        assert(rateLimited.setRefillRate(2 ether) > 0);
        assertApproxEqRel(rateLimited.maxCapacity(), 2 ether, ONE_PERCENT);
        assertEq(rateLimited.refillRate(), uint256(2 ether) / 1 days); // 2 ether / 1 day
    }

    function testRateLimited_returnsZeroIfMaxNotSet() external {
        rateLimited.setRefillRate(0);
        // `calculateCurrentLevel` no longer reverts on zero capacity —
        // dynamic-capacity subclasses rely on it being a pass-through.
        assertEq(rateLimited.calculateCurrentLevel(), 0);
    }

    function testRateLimited_returnsCurrentFilledLevel_anyDay(
        uint40 time
    ) external {
        time = uint40(bound(time, 1 days, 2 days));
        vm.warp(time);

        // Using approx because division won't be exact
        assertApproxEqRel(
            rateLimited.calculateCurrentLevel(),
            MAX_CAPACITY,
            ONE_PERCENT
        );
    }

    function testRateLimited_onlyOwnerCanSetTargetLimit() external {
        vm.prank(address(0));
        vm.expectRevert();
        rateLimited.setRefillRate(1 ether);
    }

    function testConsumedFilledLevelEvent() public {
        uint256 consumeAmount = 0.5 ether;

        vm.expectEmit(true, true, false, true);
        emit RateLimited.ConsumedFilledLevel(
            499999999999993600,
            block.timestamp
        ); // precision loss
        rateLimited.validateAndConsumeFilledLevel(consumeAmount);

        assertApproxEqRelDecimal(
            rateLimited.filledLevel(),
            MAX_CAPACITY - consumeAmount,
            1e14,
            0
        );
        assertEq(rateLimited.lastUpdated(), block.timestamp);
    }

    function testRateLimited_neverReturnsGtMaxLimit(
        uint256 _newAmount,
        uint40 _newTime
    ) external {
        _newTime = uint40(bound(_newTime, 1 days, type(uint40).max));
        vm.warp(_newTime);
        vm.assume(_newAmount <= rateLimited.calculateCurrentLevel());
        rateLimited.validateAndConsumeFilledLevel(_newAmount);
        assertLe(
            rateLimited.calculateCurrentLevel(),
            rateLimited.maxCapacity()
        );
    }

    function testRateLimited_decreasesLimitWithinSameDay() external {
        vm.warp(1 days);
        uint256 currentTargetLimit = rateLimited.calculateCurrentLevel();
        uint256 amount = 0.4 ether;
        uint256 newLimit = rateLimited.validateAndConsumeFilledLevel(amount);
        assertEq(newLimit, currentTargetLimit - amount);

        // Consume the same amount
        currentTargetLimit = rateLimited.calculateCurrentLevel();
        newLimit = rateLimited.validateAndConsumeFilledLevel(amount);
        assertEq(newLimit, currentTargetLimit - amount);

        // One more to exceed limit
        vm.expectRevert();
        rateLimited.validateAndConsumeFilledLevel(amount);
    }

    function testRateLimited_replinishesWithinSameDay() external {
        vm.warp(1 days);
        uint256 amount = 0.95 ether;
        uint256 newLimit = rateLimited.validateAndConsumeFilledLevel(amount);
        uint256 currentTargetLimit = rateLimited.calculateCurrentLevel();
        assertApproxEqRel(currentTargetLimit, 0.05 ether, ONE_PERCENT);

        // Warp to near end-of-day
        vm.warp(block.timestamp + 0.99 days);
        newLimit = rateLimited.validateAndConsumeFilledLevel(amount);
        assertApproxEqRel(newLimit, 0.05 ether, ONE_PERCENT);
    }

    function testRateLimited_shouldResetLimit_ifDurationExceeds(
        uint256 _amount
    ) external {
        // Transfer less than the limit
        vm.warp(0.5 days);
        uint256 currentTargetLimit = rateLimited.calculateCurrentLevel();
        vm.assume(_amount < currentTargetLimit);

        uint256 newLimit = rateLimited.validateAndConsumeFilledLevel(_amount);
        assertApproxEqRel(newLimit, currentTargetLimit - _amount, ONE_PERCENT);

        // Warp to a new cycle
        vm.warp(10 days);
        currentTargetLimit = rateLimited.calculateCurrentLevel();
        assertApproxEqRel(currentTargetLimit, MAX_CAPACITY, ONE_PERCENT);
    }

    function testCalculateCurrentLevel_returnsZeroWhenCapacityIsZero() public {
        rateLimited.setRefillRate(0);
        assertEq(rateLimited.calculateCurrentLevel(), 0);
    }

    function testValidateAndConsumeFilledLevel_revertsWhenExceedingLimit()
        public
    {
        vm.warp(1 days);
        uint256 initialLevel = rateLimited.calculateCurrentLevel();

        uint256 excessAmount = initialLevel + 1 ether;

        vm.expectRevert("RateLimitExceeded");
        rateLimited.validateAndConsumeFilledLevel(excessAmount);
        assertEq(rateLimited.calculateCurrentLevel(), initialLevel);
    }
}

/// @dev Behavioral contract for the dynamic-capacity bucket shared by
/// `TvlRateLimited` consumers (`DelayedFlowRouter`, `NetFlowRateLimitedHookIsm`).
/// These lock the observable semantics through the public interface, so a
/// future change to the internals that alters behavior is caught here.
contract RateLimitBehaviorTest is Test {
    DynamicRateLimited bucket;
    uint256 constant CAP = 10 ether;

    function setUp() public {
        bucket = new DynamicRateLimited();
    }

    /// Deployed before its pool is funded: reports full at the *current*
    /// capacity on first read, not a stale zero snapshot.
    function test_startsFullAtCurrentCapacity_beforeFirstUse() public {
        assertEq(bucket.calculateCurrentLevel(), 0);

        bucket.setCapacity(CAP);

        assertEq(bucket.calculateCurrentLevel(), CAP);
        assertFalse(bucket.isInitialized());
    }

    function test_consumeReducesLevelByAmount() public {
        bucket.setCapacity(CAP);

        assertEq(bucket.consume(3 ether), 7 ether);

        assertEq(bucket.filledLevel(), 7 ether);
        assertEq(bucket.calculateCurrentLevel(), 7 ether);
        assertTrue(bucket.isInitialized());
    }

    function test_consumeRevertsWhenExceedingLevel() public {
        bucket.setCapacity(CAP);

        vm.expectRevert("RateLimitExceeded");
        bucket.consume(CAP + 1);
    }

    function test_creditAddsOneToOneAndClampsAtCapacity() public {
        bucket.setCapacity(CAP);
        bucket.consume(8 ether); // level 2 ether

        assertEq(bucket.credit(3 ether), 5 ether);
        assertEq(bucket.filledLevel(), 5 ether);

        // Overshoot clamps at capacity.
        assertEq(bucket.credit(100 ether), CAP);
    }

    /// The one documented divergence from the old fork: at zero capacity a
    /// credit is a no-op (stored level untouched) and the level reads zero.
    function test_creditIsNoOpAtZeroCapacity() public {
        bucket.setCapacity(CAP);
        bucket.consume(6 ether); // level 4 ether

        bucket.setCapacity(0);

        assertEq(bucket.credit(5 ether), 0);
        assertEq(bucket.filledLevel(), 4 ether); // untouched
        assertEq(bucket.calculateCurrentLevel(), 0); // zero capacity
    }

    /// When the pool shrinks below the stored level, the current level clamps
    /// down to the new capacity.
    function test_currentLevelClampsWhenCapacityShrinks() public {
        bucket.setCapacity(CAP);
        bucket.consume(1 ether); // level 9 ether, initialized

        bucket.setCapacity(6 ether);

        assertEq(bucket.calculateCurrentLevel(), 6 ether);
    }

    function test_refillsProportionallyWithinWindow() public {
        bucket.setCapacity(CAP);
        bucket.consume(CAP); // drained to 0

        vm.warp(block.timestamp + 12 hours); // half of DURATION

        assertEq(bucket.calculateCurrentLevel(), 5 ether);
    }

    function test_levelResetsToCapacityAfterWindow() public {
        bucket.setCapacity(CAP);
        bucket.consume(CAP); // drained to 0

        vm.warp(block.timestamp + 1 days + 1);

        assertEq(bucket.calculateCurrentLevel(), CAP);
    }

    /// Soft-consume within the current level (the `DelayedFlowRouter` path):
    /// drains the bucket and owes zero delay.
    function test_softConsumeWithinLevel_owesNoDelay() public {
        bucket.setCapacity(100 ether);

        assertEq(bucket.softConsume(30 ether), 0);
        assertEq(bucket.filledLevel(), 70 ether);
    }

    /// Soft-consume beyond the current level drains to zero and returns the
    /// refill seconds needed to cover the overage.
    function test_softConsumeOverLevel_returnsProportionalDeficit() public {
        bucket.setCapacity(100 ether);

        // Overage of 50 ether against a 100 ether/day rate ⇒ half a day.
        assertEq(bucket.softConsume(150 ether), 12 hours);
        assertEq(bucket.filledLevel(), 0);
    }
}
