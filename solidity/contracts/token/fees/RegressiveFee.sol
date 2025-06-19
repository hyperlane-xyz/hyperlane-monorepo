// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Regressive Fee Structure
 * @dev Implements a regressive fee model where the fee percentage decreases as the transfer amount increases.
 *
 * The fee calculation uses a quadratic formula: fee = (maxFee * amount) / (halfAmount + amount)
 *
 * Key characteristics:
 * - Higher fee percentage for smaller transfers
 * - Lower fee percentage for larger transfers
 * - Fee approaches but never reaches maxFee as amount increases
 * - Fee approaches 0 as amount approaches 0
 *
 * maxFee The maximum fee amount (in wei) that can be charged
 * halfAmount The amount at which the fee equals half of maxFee
 *
 * Example:
 * - If maxFee = 1000 and halfAmount = 1000:
 *   - Transfer of 100 wei: fee = (1000 * 100) / (1000 + 100) = 90.9 wei (90.9%)
 *   - Transfer of 1000 wei: fee = (1000 * 1000) / (1000 + 1000) = 500 wei (50%)
 *   - Transfer of 10000 wei: fee = (1000 * 10000) / (1000 + 10000) = 909 wei (9.09%)
 *
 * This structure encourages larger transfers while discouraging dust attacks and micro-transactions.
 */
contract RegressiveFee is ITokenFee {
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(uint256 _maxFee, uint256 _halfAmount) {
        maxFee = _maxFee;
        halfAmount = _halfAmount;
    }

    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        // quadratic fee: fee = (maxFee * amount) / (halfAmount + amount)
        // where maxFee is maxFee and halfAmount is halfAmount
        // This makes the fee percentage higher for smaller amounts.
        if (halfAmount + amount == 0) return 0;
        return (maxFee * amount) / (halfAmount + amount);
    }
}
