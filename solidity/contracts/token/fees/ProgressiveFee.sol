// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BaseFee, FeeType} from "./BaseFee.sol";

/**
 * @title Progressive Fee Structure
 * @dev Implements a progressive fee model where the fee percentage increases with transfer amount
 * until reaching a peak at halfAmount, then decreases as the absolute fee approaches maxFee.
 *
 * The fee calculation uses a rational function: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
 *
 * Key characteristics:
 * - Fee percentage increases for transfers below halfAmount (progressive phase)
 * - Fee percentage peaks at halfAmount where fee = maxFee/2
 * - Fee percentage decreases for transfers above halfAmount (regressive phase due to maxFee cap)
 * - Absolute fee approaches but never reaches maxFee as amount increases
 * - Fee approaches 0 as amount approaches 0
 *
 * Example:
 * - If maxFee = 1000 and halfAmount = 10000:
 *   - Transfer of 2000 wei: fee = (1000 * 2000^2) / (10000^2 + 2000^2) = 38.5 wei (1.92% of amount)
 *   - Transfer of 10000 wei: fee = (1000 * 10000^2) / (10000^2 + 10000^2) = 500 wei (5% of amount)
 *   - Transfer of 50000 wei: fee = (1000 * 50000^2) / (10000^2 + 50000^2) = 961.5 wei (1.92% of amount)
 *
 * This structure encourages mid-sized transfers while applying lower effective rates to both
 * very small and very large transactions.
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
        if (amount == 0) {
            return 0;
        }
        uint256 amountSquared = amount ** 2;
        return (maxFee * amountSquared) / (halfAmount ** 2 + amountSquared);
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.PROGRESSIVE;
    }
}
