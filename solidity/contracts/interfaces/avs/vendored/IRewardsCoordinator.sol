// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IStrategy.sol";

/**
 * @title Interface for the `IRewardsCoordinator` contract.
 * @author Layr Labs, Inc.
 * @notice Terms of Service: https://docs.eigenlayer.xyz/overview/terms-of-service
 * @notice Allows AVSs to make "Rewards Submissions", which get distributed amongst the AVSs' confirmed
 * Operators and the Stakers delegated to those Operators.
 * Calculations are performed based on the completed RewardsSubmission, with the results posted in
 * a Merkle root against which Stakers & Operators can make claims.
 */
interface IRewardsCoordinator {
    /// STRUCTS ///
    struct StrategyAndMultiplier {
        IStrategy strategy;
        // weight used to compare shares in multiple strategies against one another
        uint96 multiplier;
    }

    /* @notice RewardsSubmission struct submitted by AVSs when making rewards for their operators and stakers
     * RewardsSubmission can be for a time range within the valid window for startTimestamp and must be within max duration.
     * See `createAVSRewardsSubmission()` for more details.
     * @param strategiesAndMultipliers The strategies and their relative weights
     * cannot have duplicate strategies and need to be sorted in ascending address order
     * @param token The rewards token to be distributed
     * @param amount The total amount of tokens to be distributed
     * @param startTimestamp The timestamp (seconds) at which the submission range is considered for distribution
     * could start in the past or in the future but within a valid range. See the diagram above.
     * @param duration The duration of the submission range in seconds. Must be <= MAX_REWARDS_DURATION
     */
    struct RewardsSubmission {
        StrategyAndMultiplier[] strategiesAndMultipliers;
        IERC20 token;
        uint256 amount;
        uint32 startTimestamp;
        uint32 duration;
    }

    /// EXTERNAL FUNCTIONS ///

    /**
     * @notice Creates a new rewards submission on behalf of an AVS, to be split amongst the
     * set of stakers delegated to operators who are registered to the `avs`
     * @param rewardsSubmissions The rewards submissions being created
     * @dev Expected to be called by the ServiceManager of the AVS on behalf of which the submission is being made
     * @dev The duration of the `rewardsSubmission` cannot exceed `MAX_REWARDS_DURATION`
     * @dev The tokens are sent to the `RewardsCoordinator` contract
     * @dev Strategies must be in ascending order of addresses to check for duplicates
     * @dev This function will revert if the `rewardsSubmission` is malformed,
     * e.g. if the `strategies` and `weights` arrays are of non-equal lengths
     */
    function createAVSRewardsSubmission(
        RewardsSubmission[] calldata rewardsSubmissions
    ) external;
}
