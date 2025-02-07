// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IStrategy.sol";

/**
 * @title Interface for the `IPaymentCoordinator` contract.
 * @author Layr Labs, Inc.
 * @notice Terms of Service: https://docs.eigenlayer.xyz/overview/terms-of-service
 * @notice Allows AVSs to make "Range Payments", which get distributed amongst the AVSs' confirmed
 * Operators and the Stakers delegated to those Operators.
 * Calculations are performed based on the completed Range Payments, with the results posted in
 * a Merkle root against which Stakers & Operators can make claims.
 */
interface IPaymentCoordinator {
    /// STRUCTS ///
    struct StrategyAndMultiplier {
        IStrategy strategy;
        // weight used to compare shares in multiple strategies against one another
        uint96 multiplier;
    }

    struct RangePayment {
        // Strategies & relative weights of shares in the strategies
        StrategyAndMultiplier[] strategiesAndMultipliers;
        IERC20 token;
        uint256 amount;
        uint64 startTimestamp;
        uint64 duration;
    }

    /// EXTERNAL FUNCTIONS ///

    /**
     * @notice Creates a new range payment on behalf of an AVS, to be split amongst the
     * set of stakers delegated to operators who are registered to the `avs`
     * @param rangePayments The range payments being created
     * @dev Expected to be called by the ServiceManager of the AVS on behalf of which the payment is being made
     * @dev The duration of the `rangePayment` cannot exceed `MAX_PAYMENT_DURATION`
     * @dev The tokens are sent to the `claimingManager` contract
     * @dev This function will revert if the `rangePayment` is malformed,
     * e.g. if the `strategies` and `weights` arrays are of non-equal lengths
     */
    function payForRange(RangePayment[] calldata rangePayments) external;
}
