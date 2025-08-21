// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IEntity} from "../common/IEntity.sol";

interface IBaseSlasher is IEntity {
    error NoBurner();
    error InsufficientBurnerGas();
    error NotNetworkMiddleware();
    error NotVault();

    /**
     * @notice Base parameters needed for slashers' deployment.
     * @param isBurnerHook if the burner is needed to be called on a slashing
     */
    struct BaseParams {
        bool isBurnerHook;
    }

    /**
     * @notice Hints for a slashable stake.
     * @param stakeHints hints for the stake checkpoints
     * @param cumulativeSlashFromHint hint for the cumulative slash amount at a capture timestamp
     */
    struct SlashableStakeHints {
        bytes stakeHints;
        bytes cumulativeSlashFromHint;
    }

    /**
     * @notice General data for the delegator.
     * @param slasherType type of the slasher
     * @param data slasher-dependent data for the delegator
     */
    struct GeneralDelegatorData {
        uint64 slasherType;
        bytes data;
    }

    /**
     * @notice Get a gas limit for the burner.
     * @return value of the burner gas limit
     */
    function BURNER_GAS_LIMIT() external view returns (uint256);

    /**
     * @notice Get a reserve gas between the gas limit check and the burner's execution.
     * @return value of the reserve gas
     */
    function BURNER_RESERVE() external view returns (uint256);

    /**
     * @notice Get the vault factory's address.
     * @return address of the vault factory
     */
    function VAULT_FACTORY() external view returns (address);

    /**
     * @notice Get the network middleware service's address.
     * @return address of the network middleware service
     */
    function NETWORK_MIDDLEWARE_SERVICE() external view returns (address);

    /**
     * @notice Get the vault's address.
     * @return address of the vault to perform slashings on
     */
    function vault() external view returns (address);

    /**
     * @notice Get if the burner is needed to be called on a slashing.
     * @return if the burner is a hook
     */
    function isBurnerHook() external view returns (bool);

    /**
     * @notice Get the latest capture timestamp that was slashed on a subnetwork.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @return latest capture timestamp that was slashed
     */
    function latestSlashedCaptureTimestamp(
        bytes32 subnetwork,
        address operator
    ) external view returns (uint48);

    /**
     * @notice Get a cumulative slash amount for an operator on a subnetwork until a given timestamp (inclusively) using a hint.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param timestamp time point to get the cumulative slash amount until (inclusively)
     * @param hint hint for the checkpoint index
     * @return cumulative slash amount until the given timestamp (inclusively)
     */
    function cumulativeSlashAt(
        bytes32 subnetwork,
        address operator,
        uint48 timestamp,
        bytes memory hint
    ) external view returns (uint256);

    /**
     * @notice Get a cumulative slash amount for an operator on a subnetwork.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @return cumulative slash amount
     */
    function cumulativeSlash(
        bytes32 subnetwork,
        address operator
    ) external view returns (uint256);

    /**
     * @notice Get a slashable amount of a stake got at a given capture timestamp using hints.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param captureTimestamp time point to get the stake amount at
     * @param hints hints for the checkpoints' indexes
     * @return slashable amount of the stake
     */
    function slashableStake(
        bytes32 subnetwork,
        address operator,
        uint48 captureTimestamp,
        bytes memory hints
    ) external view returns (uint256);
}
