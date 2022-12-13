// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {PausableReentrancyGuardUpgradeable} from "../contracts/PausableReentrancyGuard.sol";

contract MockPausableReentrancyGuard is PausableReentrancyGuardUpgradeable {
    constructor() initializer {
        __PausableReentrancyGuard_init();
    }

    function pause() external {
        _pause();
    }

    function unpause() external {
        _unpause();
    }

    function isPaused() external view returns (bool) {
        return _isPaused();
    }

    function f1() public nonReentrantAndNotPaused {}

    function f2() external nonReentrantAndNotPaused {
        f1();
    }

    function f3() external notPaused {}
}

contract PausableReentrancyGuardTest is Test {
    MockPausableReentrancyGuard mprg;

    function setUp() public {
        mprg = new MockPausableReentrancyGuard();
    }

    function testPause() public {
        mprg.f3();
        mprg.pause();
        vm.expectRevert("paused");
        mprg.f3();
        mprg.unpause();
        mprg.f3();
    }

    function testNonreentrant() public {
        mprg.f1();
        vm.expectRevert("reentrant call (or paused)");
        mprg.f2();
    }

    function testNonreentrantNotPaused() public {
        mprg.pause();
        vm.expectRevert("reentrant call (or paused)");
        mprg.f1();
    }
}
