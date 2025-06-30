// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";

/**
 * @title Regressive Fee Structure
 * @dev Implements a regressive fee model where the fee percentage decreases as the transfer amount increases.
 *
 * The fee calculation uses a rational function: fee = (maxFee * amount) / (halfAmount + amount)
 *
 * Key characteristics:
 * - Higher fee percentage for smaller transfers
 * - Lower fee percentage for larger transfers
 * - Fee approaches maxFee as amount approaches infinity
 * - Fee approaches 0 as amount approaches 0
 *
 * Example:
 * - If maxFee = 1000 and halfAmount = 1000:
 *   - Transfer of 100 wei: fee = (1000 * 100) / (1000 + 100) = 90.9 wei (90.9%)
 *   - Transfer of 1000 wei: fee = (1000 * 1000) / (1000 + 1000) = 500 wei (50%)
 *   - Transfer of 10000 wei: fee = (1000 * 10000) / (1000 + 10000) = 909 wei (9.09%)
 *
 * This structure encourages larger transfers while applying higher fees to smaller transactions.
 */
contract RegressiveFee is BaseFee {
    constructor(
        address _token,
        uint256 _maxFee,
        uint256 _halfAmount,
        address beneficiary
    ) BaseFee(_token, _maxFee, _halfAmount, beneficiary) {}

    function _quoteTransfer(
        uint256 amount
    ) internal view override returns (uint256 fee) {
        uint256 denominator = halfAmount + amount;
        return denominator == 0 ? 0 : (maxFee * amount) / denominator;
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.REGRESSIVE;
    }
}
