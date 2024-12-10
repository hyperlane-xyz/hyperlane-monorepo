// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint, SignedCheckpoint} from "../libs/CheckpointLib.sol";
import {IValidatorAnnounce} from "./IValidatorAnnounce.sol";

/**
 * @title ICheckpointStorage
 * @notice Interface for storing validator checkpoints and metadata. Works alongside ValidatorAnnounce
 * which handles the validator announcements separately.
 */
interface ICheckpointStorage {
    struct AgentMetadata {
        string gitSha;
    }

    event CheckpointSubmitted(
        address indexed validator,
        SignedCheckpoint signedCheckpoint,
        uint32 index
    );

    event MetadataUpdated(address indexed validator, string gitSha);

    /**
     * @notice Returns the latest checkpoint index
     * @return The latest checkpoint index
     */
    function latestIndex() external view returns (uint32);

    /**
     * @notice Returns the validator announce contract
     * @return The validator announce contract
     */
    function validatorAnnounce() external view returns (IValidatorAnnounce);

    /**
     * @notice Returns the latest index for all validators
     * @return The latest validator index
     */
    function validatorLatestIndex() external view returns (uint32);

    /**
     * @notice Write a new checkpoint
     * @param signedCheckpoint The signed checkpoint to write
     */
    function writeCheckpoint(
        SignedCheckpoint calldata signedCheckpoint
    ) external;

    /**
     * @notice Fetch a checkpoint for a specific validator and index
     * @param validator The validator address
     * @param index The checkpoint index
     * @return The signed checkpoint
     */
    function fetchCheckpoint(
        address validator,
        uint32 index
    ) external view returns (SignedCheckpoint memory);

    /**
     * @notice Update validator metadata
     * @param gitSha The git SHA to store
     */
    function writeMetadata(string calldata gitSha) external;

    /**
     * @notice Fetch validator metadata
     * @param validator The validator address
     * @return The validator's metadata
     */
    function fetchMetadata(
        address validator
    ) external view returns (AgentMetadata memory);

    /**
     * @notice Returns the submitted checkpoint for a validator at a specific index
     * @param validator The validator address
     * @param index The checkpoint index
     * @return The signed checkpoint
     */
    function submittedCheckpoints(
        address validator,
        uint32 index
    ) external view returns (SignedCheckpoint memory);

    /**
     * @notice Returns the metadata for a validator
     * @param validator The validator address
     * @return The validator metadata
     */
    function validatorMetadata(
        address validator
    ) external view returns (AgentMetadata memory);
}
