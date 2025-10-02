// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBaseSlasher} from "./IBaseSlasher.sol";

interface ISlasher is IBaseSlasher {
    error InsufficientSlash();
    error InvalidCaptureTimestamp();

    /**
     * @notice Initial parameters needed for a slasher deployment.
     * @param baseParams base parameters for slashers' deployment
     */
    struct InitParams {
        IBaseSlasher.BaseParams baseParams;
    }

    /**
     * @notice Hints for a slash.
     * @param slashableStakeHints hints for the slashable stake checkpoints
     */
    struct SlashHints {
        bytes slashableStakeHints;
    }

    /**
     * @notice Extra data for the delegator.
     * @param slashableStake amount of the slashable stake before the slash (cache)
     * @param stakeAt amount of the stake at the capture time (cache)
     */
    struct DelegatorData {
        uint256 slashableStake;
        uint256 stakeAt;
    }

    /**
     * @notice Emitted when a slash is performed.
     * @param subnetwork subnetwork that requested the slash
     * @param operator operator that is slashed
     * @param slashedAmount virtual amount of the collateral slashed
     * @param captureTimestamp time point when the stake was captured
     */
    event Slash(
        bytes32 indexed subnetwork,
        address indexed operator,
        uint256 slashedAmount,
        uint48 captureTimestamp
    );

    /**
     * @notice Perform a slash using a subnetwork for a particular operator by a given amount using hints.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param amount maximum amount of the collateral to be slashed
     * @param captureTimestamp time point when the stake was captured
     * @param hints hints for checkpoints' indexes
     * @return slashedAmount virtual amount of the collateral slashed
     * @dev Only a network middleware can call this function.
     */
    function slash(
        bytes32 subnetwork,
        address operator,
        uint256 amount,
        uint48 captureTimestamp,
        bytes calldata hints
    ) external returns (uint256 slashedAmount);
}
