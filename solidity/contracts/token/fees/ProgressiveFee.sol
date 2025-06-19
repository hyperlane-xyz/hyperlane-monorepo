// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Progressive Fee Structure
 * @dev Implements a progressive fee model where the fee percentage increases as the transfer amount increases.
 *
 * The fee calculation uses a quadratic formula: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
 *
 * Key characteristics:
 * - Lower fee percentage for smaller transfers
 * - Higher fee percentage for larger transfers
 * - Fee approaches but never reaches maxFee as amount increases
 * - Fee approaches 0 as amount approaches 0
 *
 * feeNumerator The maximum fee amount (in wei) that can be charged
 * feeDenominator The amount at which the fee equals half of maxFee
 *
 * Example:
 * - If feeNumerator = 1000 and feeDenominator = 1000:
 *   - Transfer of 100 wei: fee = (1000 * 100^2) / (1000^2 + 100^2) = 9.9 wei (9.9%)
 *   - Transfer of 1000 wei: fee = (1000 * 1000^2) / (1000^2 + 1000^2) = 500 wei (50%)
 *   - Transfer of 10000 wei: fee = (1000 * 10000^2) / (1000^2 + 10000^2) = 990 wei (99%)
 *
 * This structure discourages large transfers while encouraging smaller transactions and micro-payments.
 */
contract ProgressiveFee is ITokenFee {
    uint256 public immutable feeNumerator;
    uint256 public immutable feeDenominator;

    constructor(uint256 _feeNumerator, uint256 _feeDenominator) {
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
    }

    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        // quadratic fee: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
        // where feeNumerator is maxFee and feeDenominator is halfAmount
        // This makes the fee percentage higher for larger amounts.
        if (feeDenominator * feeDenominator + amount * amount == 0) return 0;
        return (feeNumerator * amount * amount) / (feeDenominator * feeDenominator + amount * amount);
    }
}
