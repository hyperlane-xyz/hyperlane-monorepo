// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint} from "../libs/CheckpointLib.sol";

struct SignedCheckpoint {
    Checkpoint checkpoint;
    bytes signature;
}

interface IOnchainCheckpointStorage {
    event CheckpointWritten(
        address indexed validator,
        uint32 indexed index,
        bytes32 root,
        bytes32 messageId
    );

    event LatestIndexUpdated(address indexed validator, uint32 indexed index);

    event MetadataWritten(address indexed validator, string metadata);

    event ReorgStatusWritten(address indexed validator, bytes reorgData);

    /**
     * @notice Writes a checkpoint verified by signature and updates latest index if higher.
     * @param _checkpoint The checkpoint struct to write.
     * @param _signature The 65-byte validator signature over the checkpoint digest.
     * @return The recovered validator address.
     */
    function writeCheckpoint(
        Checkpoint calldata _checkpoint,
        bytes calldata _signature
    ) external returns (address);

    /**
     * @notice Writes a signed checkpoint and updates latest index if higher.
     * @param _signedCheckpoint The signed checkpoint struct.
     * @return The recovered validator address.
     */
    function writeCheckpoint(
        SignedCheckpoint calldata _signedCheckpoint
    ) external returns (address);

    /**
     * @notice Retrieves a checkpoint and its signature for a given validator and index.
     * @param _validator The address of the validator.
     * @param _index The index of the checkpoint.
     * @return checkpoint The stored checkpoint.
     * @return signature The stored signature bytes.
     */
    function getCheckpoint(
        address _validator,
        uint32 _index
    )
        external
        view
        returns (Checkpoint memory checkpoint, bytes memory signature);

    /**
     * @notice Checks whether a checkpoint exists for a validator at an index.
     * @param _validator The address of the validator.
     * @param _index The index of the checkpoint.
     * @return True if checkpoint exists, false otherwise.
     */
    function hasCheckpoint(
        address _validator,
        uint32 _index
    ) external view returns (bool);

    /**
     * @notice Retrieves the latest checkpoint index written by a validator.
     * @param _validator The address of the validator.
     * @return index The latest checkpoint index.
     * @return exists True if the validator has written any checkpoints.
     */
    function getLatestIndex(
        address _validator
    ) external view returns (uint32 index, bool exists);

    /**
     * @notice Updates the latest index for the caller validator.
     * @param _index The new latest index.
     */
    function updateLatestIndex(uint32 _index) external;

    /**
     * @notice Stores agent metadata for the caller validator.
     * @param _metadata Serialized metadata string.
     */
    function writeMetadata(string calldata _metadata) external;

    /**
     * @notice Retrieves metadata for a validator.
     * @param _validator The address of the validator.
     * @return The metadata string.
     */
    function getMetadata(
        address _validator
    ) external view returns (string memory);

    /**
     * @notice Stores reorg status data for the caller validator.
     * @param _reorgData Serialized reorg status bytes.
     */
    function writeReorgStatus(bytes calldata _reorgData) external;

    /**
     * @notice Retrieves reorg status data for a validator.
     * @param _validator The address of the validator.
     * @return The reorg status bytes.
     */
    function getReorgStatus(
        address _validator
    ) external view returns (bytes memory);
}
