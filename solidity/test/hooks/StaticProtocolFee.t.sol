// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {StaticProtocolFee} from "../../contracts/hooks/StaticProtocolFee.sol";

contract StaticProtocolFeeTest is Test {
    StaticProtocolFee internal fees;

    address internal alice = address(0x1); // alice the user
    address internal bob = address(0x2); // bob the beneficiary

    function setUp() public {
        fees = new StaticProtocolFee(1e16, 1e15, bob);
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
        vm.expectRevert("StaticProtocolFee: insufficient protocol fee");
        fees.postDispatch{value: feeSent}("", "");

        assertEq(alice.balance, balanceBefore);
    }

    function testFuzz_postDispatch_invalidMetadata(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        feeSent = bound(feeSent, feeRequired + 1, 10 * feeRequired);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        vm.expectRevert("StaticProtocolFee: invalid metadata");
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

        bytes memory metadata = abi.encodePacked(alice);

        vm.prank(alice);
        fees.postDispatch{value: feeSent}(metadata, "");

        assertEq(alice.balance, balanceBefore - feeRequired);
    }

    function testFuzz_collectProtocolFee(
        uint256 feeRequired,
        uint256 dispatchCalls
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        // no of postDispatch calls to be made
        dispatchCalls = bound(dispatchCalls, 1, 1000);
        vm.deal(alice, feeRequired * dispatchCalls);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = bob.balance;

        for (uint256 i = 0; i < dispatchCalls; i++) {
            vm.prank(alice);
            fees.postDispatch{value: feeRequired}("", "");
        }

        fees.collectProtocolFees();

        assertEq(bob.balance, balanceBefore + feeRequired * dispatchCalls);
    }

    // ============ Helper Functions ============

    receive() external payable {}
}
