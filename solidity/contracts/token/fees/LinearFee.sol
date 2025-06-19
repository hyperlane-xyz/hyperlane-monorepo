// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Linear Fee Structure
 * @dev Implements a linear fee model where the fee is calculated as a fixed percentage of the transfer amount.
 *
 * The fee calculation follows the formula:
 *   fee = min(maxFee, (amount * maxFee) / halfAmount)
 *
 * For example:
 * - If maxFee = 5 and halfAmount = 1000, the fee is 0.5% of the amount
 * - If maxFee = 10 and halfAmount = 100, the fee is 10% of the amount
 * - For amounts above halfAmount, the fee increases linearly until it reaches maxFee, after which it is capped.
 *
 * This creates a simple, predictable fee structure where the fee scales linearly with the transfer amount.
 *
 * @dev The fee is always rounded down due to integer division
 * @dev halfAmount should be greater than 0 to avoid division by zero
 */
contract LinearFee is ITokenFee {
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(uint256 _maxFee, uint256 _halfAmount) {
        require(_halfAmount > 0, "LinearFee: halfAmount must be non‑zero");
        maxFee = _maxFee;
        halfAmount = _halfAmount;
    }

    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        uint256 uncapped = (amount * maxFee) / halfAmount;
        return uncapped > maxFee ? maxFee : uncapped;
    }
}
