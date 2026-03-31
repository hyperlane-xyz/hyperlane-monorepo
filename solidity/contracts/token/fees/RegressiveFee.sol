// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";

/**
 * @title Regressive Fee Structure
 * @dev Implements a regressive fee model where the fee percentage continuously decreases as the transfer amount increases.
 *
 * The fee calculation uses a rational function: fee = (maxFee * amount) / (halfAmount + amount)
 *
 * Key characteristics:
 * - Fee percentage continuously decreases as amount increases (regressive throughout)
 * - At halfAmount, fee = maxFee/2 and fee percentage = maxFee/(2*halfAmount)
 * - Absolute fee approaches but never reaches maxFee as amount approaches infinity
 * - Fee approaches 0 as amount approaches 0
 *
 * Example:
 * - If maxFee = 1000 and halfAmount = 5000:
 *   - Transfer of 1000 wei: fee = (1000 * 1000) / (5000 + 1000) = 166.7 wei (16.67% of amount)
 *   - Transfer of 5000 wei: fee = (1000 * 5000) / (5000 + 5000) = 500 wei (10% of amount)
 *   - Transfer of 20000 wei: fee = (1000 * 20000) / (5000 + 20000) = 800 wei (4% of amount)
 *
 * This structure encourages larger transfers while discouraging smaller transactions with higher
 * effective fee rates.
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
