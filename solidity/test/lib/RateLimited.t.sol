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

    function testRateLimited_revertsIfMaxNotSet() external {
        rateLimited.setRefillRate(0);
        vm.expectRevert();
        rateLimited.calculateCurrentLevel();
    }

    function testRateLimited_returnsCurrentFilledLevel_anyDay(
        uint40 time
    ) external {
        bound(time, 1 days, 2 days);
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

    function testCalculateCurrentLevel_revertsWhenCapacityIsZero() public {
        rateLimited.setRefillRate(0);

        vm.expectRevert("RateLimitNotSet");
        rateLimited.calculateCurrentLevel();
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
