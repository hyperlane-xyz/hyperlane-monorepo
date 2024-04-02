// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;
import {Test} from "forge-std/Test.sol";
import {RateLimited} from "../../contracts/libs/RateLimited.sol";
import "forge-std/console.sol";

contract RateLimitLibTest is Test {
    RateLimited rateLimited;
    uint256 constant ONE_PERCENT = 1e16;
    address HOOK = makeAddr("HOOK");

    function setUp() public {
        rateLimited = new RateLimited();
        rateLimited.setLimitAmount(HOOK, 1 ether);
    }

    function testRateLimited_setsNewLimit() external {
        RateLimited.Limit memory limit = rateLimited.setLimitAmount(
            HOOK,
            2 ether
        );
        assertEq(limit.max, 2 ether);
        assertEq(limit.tokenPerSecond, 23148148148148); // 2 ether / 1 day
    }

    function testRateLimited_revertsIfMaxNotSet() external {
        rateLimited.setLimitAmount(HOOK, 0);
        vm.expectRevert();
        rateLimited.getCurrentLimitAmount(HOOK);
    }

    function testRateLimited_returnsCurrentLimit_forHalfDay() external {
        vm.warp(0.5 days);

        // Using approx because division won't be exact
        assertApproxEqRel(
            rateLimited.getCurrentLimitAmount(HOOK),
            0.5 ether,
            ONE_PERCENT
        );
    }

    // function testRateLimited_onlyOwnerCanSet() {

    // }

    function testRateLimited_neverReturnsGtMaxLimit(uint40 newTime) external {
        (, , , uint256 max) = rateLimited.limits(HOOK);

        vm.warp(newTime);
        assertLe(rateLimited.getCurrentLimitAmount(HOOK), max);
    }
}
