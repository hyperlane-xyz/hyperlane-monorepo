// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;
import {Test} from "forge-std/Test.sol";
import {RateLimited} from "../../contracts/libs/RateLimited.sol";

contract RateLimitLibTest is Test {
    RateLimited rateLimited;
    uint256 constant ONE_PERCENT = 1e16;
    address HOOK = makeAddr("HOOK");

    function setUp() public {
        rateLimited = new RateLimited();
        rateLimited.setTargetLimit(HOOK, 1 ether);
    }

    function testRateLimited_setsNewLimit() external {
        RateLimited.Limit memory limit = rateLimited.setTargetLimit(
            HOOK,
            2 ether
        );
        assertEq(limit.max, 2 ether);
        assertEq(limit.tokenPerSecond, 23148148148148); // 2 ether / 1 day
    }

    function testRateLimited_revertsIfMaxNotSet() external {
        rateLimited.setTargetLimit(HOOK, 0);
        vm.expectRevert();
        rateLimited.getTargetLimit(HOOK);
    }

    function testRateLimited_returnsCurrentLimit_forHalfDay() external {
        vm.warp(0.5 days);

        // Using approx because division won't be exact
        assertApproxEqRel(
            rateLimited.getTargetLimit(HOOK),
            0.5 ether,
            ONE_PERCENT
        );
    }

    function testRateLimited_onlyOwnerCanSetTargetLimit() external {
        vm.prank(address(0));
        vm.expectRevert();
        rateLimited.setTargetLimit(HOOK, 1 ether);
    }

    function testRateLimited_neverReturnsGtMaxLimit(uint40 _newTime) external {
        (, , , uint256 max) = rateLimited.limits(HOOK);

        vm.warp(_newTime);
        assertLe(rateLimited.getTargetLimit(HOOK), max);
    }

    function testRateLimited_shouldReturnNewLimit_ifBelowMaxLimit(
        uint256 _newAmount
    ) external {
        vm.assume(_newAmount <= rateLimited.getTargetLimit(HOOK));
        uint256 newLimit = rateLimited.getLimit(HOOK) + _newAmount;
        assertEq(
            rateLimited.validateAndIncrementLimit(HOOK, _newAmount),
            newLimit
        );
    }
}
