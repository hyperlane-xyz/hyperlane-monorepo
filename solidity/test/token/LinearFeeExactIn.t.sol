// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {BaseFee, FeeType} from "../../contracts/token/fees/BaseFee.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

/// @dev Minimal BaseFee that does NOT override exact-in, to exercise the
///      default `ExactInNotSupported` revert.
contract UnsupportedExactInFee is BaseFee {
    constructor(
        address _token,
        uint256 _maxFee,
        uint256 _halfAmount,
        address _owner
    ) BaseFee(_token, _maxFee, _halfAmount, _owner) {}

    function feeType() external pure override returns (FeeType) {
        return FeeType.ZERO;
    }
}

contract LinearFeeExactInTest is Test {
    LinearFee fee;

    address constant FEE_TOKEN = address(0xFEE);
    address constant OWNER = address(0x111);

    uint32 constant DEST = 42;
    bytes32 constant RECIPIENT = bytes32(uint256(0xBEEF));

    uint256 constant MAX_FEE = 0.01 ether;
    uint256 constant HALF_AMOUNT = 0.5 ether; // cap reached at amount = 1 ether

    function setUp() public {
        fee = new LinearFee(FEE_TOKEN, MAX_FEE, HALF_AMOUNT, OWNER);
    }

    // Mirror of LinearFee._computeLinearFee.
    function _fee(
        uint256 maxFee_,
        uint256 halfAmount_,
        uint256 amount
    ) internal pure returns (uint256) {
        if (maxFee_ == 0 || halfAmount_ == 0) return 0;
        uint256 uncapped = (amount * maxFee_) / (2 * halfAmount_);
        return uncapped > maxFee_ ? maxFee_ : uncapped;
    }

    function _forwardFee(uint256 amount) internal view returns (uint256) {
        Quote[] memory q = fee.quoteTransferRemote(DEST, RECIPIENT, amount);
        return q[0].amount;
    }

    // amount + fee(amount) must fit the budget, and amount+1 must not: the
    // returned amount is the exact-in maximum.
    function _assertMaximal(uint256 maxSpend) internal view {
        uint256 amount = fee.quoteTransferRemoteFrom(DEST, RECIPIENT, maxSpend);
        assertLe(amount, maxSpend, "amount exceeds budget");
        assertLe(amount + _forwardFee(amount), maxSpend, "charge over budget");
        // amount + 1 must exceed the budget (no larger deliverable exists).
        uint256 up = amount + 1;
        assertGt(up + _forwardFee(up), maxSpend, "not maximal");
    }

    // ============ Deterministic boundaries ============

    function test_exactIn_uncappedRegion() public view {
        // Small budget: sits in the linear (uncapped) region, amount < 1 ether.
        _assertMaximal(0.1 ether);
    }

    function test_exactIn_capBoundary() public view {
        // Budget straddling the cap boundary (amount ~= 2*halfAmount).
        _assertMaximal(1 ether + MAX_FEE);
        _assertMaximal(1 ether + MAX_FEE - 1);
        _assertMaximal(1 ether + MAX_FEE + 1);
    }

    function test_exactIn_cappedRegion() public view {
        // Large budget: fee saturates at MAX_FEE, amount = maxSpend - MAX_FEE.
        uint256 maxSpend = 100 ether;
        uint256 amount = fee.quoteTransferRemoteFrom(DEST, RECIPIENT, maxSpend);
        assertEq(amount, maxSpend - MAX_FEE);
        _assertMaximal(maxSpend);
    }

    function test_exactIn_zeroBudget() public view {
        assertEq(fee.quoteTransferRemoteFrom(DEST, RECIPIENT, 0), 0);
    }

    function test_exactIn_budgetBelowMaxFee() public view {
        // Even when the budget is below MAX_FEE, the uncapped branch yields the
        // largest feasible amount (fee grows with amount, so a small amount is
        // still deliverable).
        _assertMaximal(MAX_FEE / 2);
        _assertMaximal(MAX_FEE);
    }

    // ============ Round-trip: exact-out then exact-in ============

    function testFuzz_roundTrip_exactOutThenIn(uint256 amount) public view {
        amount = bound(amount, 0, 1e30);
        uint256 charge = amount + _forwardFee(amount);
        // With budget == charge, we must be able to afford at least `amount`.
        uint256 recovered = fee.quoteTransferRemoteFrom(
            DEST,
            RECIPIENT,
            charge
        );
        assertGe(recovered, amount, "cannot recover exact-out amount");
        // And recovered stays within budget.
        assertLe(recovered + _forwardFee(recovered), charge);
    }

    // ============ Fuzz: maximality across the whole curve ============

    function testFuzz_exactIn_isMaximal(uint256 maxSpend) public view {
        maxSpend = bound(maxSpend, 0, 1e40);
        _assertMaximal(maxSpend);
    }

    function testFuzz_exactIn_paramsAndBudget(
        uint256 maxFee_,
        uint256 halfAmount_,
        uint256 maxSpend
    ) public {
        maxFee_ = bound(maxFee_, 1, 1e27);
        halfAmount_ = bound(halfAmount_, 1, 1e27);
        maxSpend = bound(maxSpend, 0, 1e40);

        LinearFee f = new LinearFee(FEE_TOKEN, maxFee_, halfAmount_, OWNER);
        uint256 amount = f.quoteTransferRemoteFrom(DEST, RECIPIENT, maxSpend);

        assertLe(amount, maxSpend);
        assertLe(amount + _fee(maxFee_, halfAmount_, amount), maxSpend);
        uint256 up = amount + 1;
        assertGt(up + _fee(maxFee_, halfAmount_, up), maxSpend);
    }

    // ============ BaseFee default revert ============

    function test_exactIn_defaultReverts() public {
        UnsupportedExactInFee unsupported = new UnsupportedExactInFee(
            FEE_TOKEN,
            MAX_FEE,
            HALF_AMOUNT,
            OWNER
        );
        vm.expectRevert(BaseFee.ExactInNotSupported.selector);
        unsupported.quoteTransferRemoteFrom(DEST, RECIPIENT, 1 ether);
    }
}
