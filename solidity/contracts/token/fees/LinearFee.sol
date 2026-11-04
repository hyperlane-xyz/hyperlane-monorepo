// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Linear Fee Structure
 * @dev Implements a linear fee model where the fee increases linearly with the transfer amount, up to a maximum cap.
 *
 * The fee calculation follows the formula:
 *   fee = min(maxFee, (amount * maxFee) / (2 * halfAmount))
 *
 * For example:
 * - If maxFee = 10 and halfAmount = 1000, then:
 *     - For amount = 1000, fee = 5 (half of maxFee)
 *     - For amount = 2000, fee = 10 (maxFee)
 *     - For amount = 500, fee = 2 (rounded down)
 * - For amounts above 2 * halfAmount, the fee is capped at maxFee.
 *
 * This creates a simple, predictable fee structure where the fee scales linearly with the transfer amount until it reaches the cap.
 *
 * @dev The fee is always rounded down due to integer division
 */
contract LinearFee is BaseFee {
    constructor(
        address _token,
        uint256 _maxFee,
        uint256 _halfAmount,
        address _owner
    ) BaseFee(_token, _maxFee, _halfAmount, _owner) {}

    function _quoteTransfer(
        uint256 amount
    ) internal view override returns (uint256 fee) {
        return _computeLinearFee(maxFee, halfAmount, amount);
    }

    function _computeLinearFee(
        uint256 maxFee_,
        uint256 halfAmount_,
        uint256 amount
    ) internal pure returns (uint256) {
        if (maxFee_ == 0 || halfAmount_ == 0) return 0;
        uint256 uncapped = (amount * maxFee_) / (2 * halfAmount_);
        return uncapped > maxFee_ ? maxFee_ : uncapped;
    }

    function _maxAmountForSpend(
        uint32 /*_destination*/,
        bytes32 /*_recipient*/,
        uint256 _maxSpend
    ) internal view virtual override returns (uint256) {
        return _invertCappedLinear(maxFee, halfAmount, _maxSpend);
    }

    /**
     * @notice Closed-form inverse of the capped-linear fee curve.
     * @dev Returns the largest `amount` with `amount + fee(amount) <= maxSpend`,
     *      where `fee` is `_computeLinearFee(maxFee_, halfAmount_, amount)`.
     *
     *      The forward charge `T(a) = a + min(maxFee_, floor(a*maxFee_/D))`,
     *      with `D = 2*halfAmount_`, is nondecreasing, so the inverse is well
     *      defined. Two regions:
     *        - Capped (`a >= D`): `fee == maxFee_`, so `T(a) = a + maxFee_`.
     *          Solved exactly by `a = maxSpend - maxFee_` when
     *          `maxSpend >= D + maxFee_`.
     *        - Uncapped (`a < D`): `T` has slope `(D + maxFee_)/D`. The continuous
     *          inverse `floor(maxSpend*D/(D+maxFee_))` is always feasible and
     *          undershoots the true integer answer by at most one (a single
     *          floor in `fee`), corrected by a bounded +1 fixup.
     */
    function _invertCappedLinear(
        uint256 maxFee_,
        uint256 halfAmount_,
        uint256 maxSpend
    ) internal pure returns (uint256) {
        // Degenerate curve: fee is always zero, so the whole budget is amount.
        if (maxFee_ == 0 || halfAmount_ == 0) return maxSpend;

        uint256 D = 2 * halfAmount_;

        // Capped region: fee saturates at maxFee_ once amount >= D.
        if (maxSpend >= D + maxFee_) {
            return maxSpend - maxFee_;
        }

        // Uncapped region. mulDiv avoids intermediate overflow.
        uint256 amount = Math.mulDiv(maxSpend, D, D + maxFee_);
        if (
            amount + 1 + _computeLinearFee(maxFee_, halfAmount_, amount + 1) <=
            maxSpend
        ) {
            amount += 1;
        }
        return amount;
    }

    function feeType() external pure virtual override returns (FeeType) {
        return FeeType.LINEAR;
    }
}
