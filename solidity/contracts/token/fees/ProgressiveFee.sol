// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Progressive Fee Structure
 * @dev Implements a progressive fee model where the fee percentage increases as the transfer amount increases.
 *
 * The fee calculation uses a rational function: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
 *
 * Key characteristics:
 * - Higher fee percentage for larger transfers
 * - Lower fee percentage for smaller transfers
 * - Fee approaches but never reaches maxFee as amount increases
 * - Fee approaches 0 as amount approaches 0
 *
 * maxFee The maximum fee amount (in wei) that can be charged
 * halfAmount The amount at which the fee equals half of maxFee
 *
 * Example:
 * - If maxFee = 1000 and halfAmount = 1000:
 *   - Transfer of 100 wei: fee = (1000 * 100^2) / (1000^2 + 100^2) = 9.9 wei (9.9%)
 *   - Transfer of 1000 wei: fee = (1000 * 1000^2) / (1000^2 + 1000^2) = 500 wei (50%)
 *   - Transfer of 10000 wei: fee = (1000 * 10000^2) / (1000^2 + 10000^2) = 990 wei (99%)
 *
 * This structure encourages smaller transactions while applying higher fees to larger transfers.
 */
contract ProgressiveFee is ITokenFee {
    uint256 public immutable maxFee;
    uint256 public immutable halfAmount;

    constructor(uint256 _maxFee, uint256 _halfAmount) {
        maxFee = _maxFee;
        halfAmount = _halfAmount;
    }

    function quoteTransfer(
        uint256 amount
    ) external view override returns (uint256 fee) {
        // Progressive fee using rational function: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
        // This makes the fee percentage higher for larger amounts, creating a progressive fee structure
        if (halfAmount * halfAmount + amount * amount == 0) return 0;
        return
            (maxFee * amount * amount) /
            (halfAmount * halfAmount + amount * amount);
    }
}
