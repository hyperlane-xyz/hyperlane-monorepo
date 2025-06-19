// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Linear Fee Structure
 * @dev Implements a linear fee model where the fee is calculated as a fixed percentage of the transfer amount.
 *
 * The fee calculation follows the formula: fee = (amount * feeNumerator) / feeDenominator
 *
 * For example:
 * - If feeNumerator = 5 and feeDenominator = 1000, the fee is 0.5% of the amount
 * - If feeNumerator = 10 and feeDenominator = 100, the fee is 10% of the amount
 *
 * This creates a simple, predictable fee structure where the fee scales linearly with the transfer amount.
 *
 * @dev The fee is always rounded down due to integer division
 * @dev feeDenominator should be greater than 0 to avoid division by zero
 */
contract LinearFee is ITokenFee {
    uint256 public immutable feeNumerator;
    uint256 public immutable feeDenominator;

    constructor(uint256 _feeNumerator, uint256 _feeDenominator) {
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
    }

    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        return (amount * feeNumerator) / feeDenominator;
    }
}
