// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";

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
        uint256 uncapped = (amount * maxFee) / (2 * halfAmount);
        return uncapped > maxFee ? maxFee : uncapped;
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.LINEAR;
    }
}
