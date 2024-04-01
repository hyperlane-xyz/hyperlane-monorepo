// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;
import {Test} from "forge-std/Test.sol";
import {RateLimited} from "../../contracts/libs/RateLimited.sol";
import "forge-std/console.sol";

contract RateLimitLibTest is Test {
    using RateLimited for RateLimited.Limit;
    uint256 constant ONE_PERCENT = 1e16;
    mapping(address => RateLimited.Limit) internal limits;

    function setUp() public {
        RateLimited.Limit storage limit = limits[address(this)];
        limit.setLimitAmount(1 ether);
    }

    function testRateLimited_setsNewLimit() external {
        RateLimited.Limit storage limit = limits[address(this)];
        limit.setLimitAmount(2 ether);
        assertEq(limit.max, 2 ether);
        assertEq(limit.tokenPerSecond, 23148148148148); // 2 ether / 1 day
    }

    function testRateLimited_revertsIfMaxNotSet() external {
        RateLimited.Limit storage limit = limits[address(this)];
        limit.setLimitAmount(0);
        vm.expectRevert();
        limit.getCurrentLimitAmount();
    }

    function testRateLimited_returnsCurrentLimit_forHalfDay() external {
        RateLimited.Limit storage limit = limits[address(this)];
        vm.warp(0.5 days);

        // Using approx because division won't be exact
        assertApproxEqRel(
            limit.getCurrentLimitAmount(),
            0.5 ether,
            ONE_PERCENT
        );
    }

    function testRateLimited_neverReturnsGtMaxLimit(uint40 newTime) external {
        RateLimited.Limit storage limit = limits[address(this)];
        vm.warp(newTime);

        assertLe(limit.getCurrentLimitAmount(), limit.max);
    }
}
