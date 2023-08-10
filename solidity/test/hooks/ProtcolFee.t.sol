// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {StaticProtocolFee} from "../../contracts/hooks/StaticProtocolFee.sol";

contract StaticProtocolFeeTest is Test {
    StaticProtocolFee internal fees;

    address internal alice = address(0x1);

    function setUp() public {
        fees = new StaticProtocolFee(1e15, address(this));
    }

    function testConstructor() public {
        assertEq(fees.protocolFee(), 1e15);
    }

    function testSetProtocolFee(uint256 fee) public {
        fee = bound(fee, 0, fees.MAX_PROTOCOL_FEE());
        fees.setProtocolFee(fee);
        assertEq(fees.protocolFee(), fee);
    }

    function testFuzz_postDispatch_inusfficientFees(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        // bound feeSent to be less than feeRequired
        feeSent = bound(feeSent, 0, feeRequired - 1);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        vm.expectRevert("insufficient protocol fee");
        fees.postDispatch{value: feeSent}("", "");

        assertEq(alice.balance, balanceBefore);
    }

    function testFuzz_postDispatch_sufficientFees(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        feeSent = bound(feeSent, feeRequired, 10 * feeRequired);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        fees.postDispatch{value: feeSent}("", "");

        assertEq(alice.balance, balanceBefore - feeRequired);
    }

    function testFuzz_collectProtocolFee(
        uint256 feeRequired,
        uint256 dispatchCalls,
        uint256 feeToBeCollected
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        dispatchCalls = bound(dispatchCalls, 1, 1000);
        feeToBeCollected = bound(
            feeToBeCollected,
            1,
            dispatchCalls * feeRequired
        );
        vm.deal(alice, feeRequired * dispatchCalls);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = address(this).balance;

        for (uint256 i = 0; i < dispatchCalls; i++) {
            vm.prank(alice);
            fees.postDispatch{value: feeRequired}("", "");
        }

        fees.collectProtocolFees(feeToBeCollected);

        assertEq(address(this).balance, balanceBefore + feeToBeCollected);
    }

    // ============ Helper Functions ============

    receive() external payable {}
}
