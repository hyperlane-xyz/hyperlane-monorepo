// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";

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
 * Example:
 * - If maxFee = 1000 and halfAmount = 1000:
 *   - Transfer of 100 wei: fee = (1000 * 100^2) / (1000^2 + 100^2) = 9.9 wei (9.9%)
 *   - Transfer of 1000 wei: fee = (1000 * 1000^2) / (1000^2 + 1000^2) = 500 wei (50%)
 *   - Transfer of 10000 wei: fee = (1000 * 10000^2) / (1000^2 + 10000^2) = 990 wei (99%)
 *
 * This structure encourages smaller transactions while applying higher fees to larger transfers.
 */
contract ProgressiveFee is BaseFee {
    constructor(
        address _token,
        uint256 _maxFee,
        uint256 _halfAmount,
        address beneficiary
    ) BaseFee(_token, _maxFee, _halfAmount, beneficiary) {}

    function _quoteTransfer(
        uint256 amount
    ) internal view override returns (uint256 fee) {
        uint256 amountSquared = amount ** 2;
        uint256 denominator = halfAmount ** 2 + amountSquared;
        return denominator == 0 ? 0 : (maxFee * amountSquared) / denominator;
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.PROGRESSIVE;
    }
}
