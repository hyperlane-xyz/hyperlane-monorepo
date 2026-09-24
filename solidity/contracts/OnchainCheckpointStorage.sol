// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {IOnchainCheckpointStorage, SignedCheckpoint} from "./interfaces/IOnchainCheckpointStorage.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract OnchainCheckpointStorage is IOnchainCheckpointStorage {
    using CheckpointLib for Checkpoint;
    using ECDSA for bytes32;

    mapping(address => uint32) public latestIndex;
    mapping(address => bool) public hasCheckpoints;
    mapping(address => mapping(uint32 => SignedCheckpoint))
        private _checkpoints;
    mapping(address => string) public validatorMetadata;
    mapping(address => bytes) public validatorReorgStatus;

    /**
     * @notice Writes a checkpoint verified by signature and updates latest index if higher.
     * @param _checkpoint The checkpoint struct to write.
     * @param _signature The 65-byte validator signature over the checkpoint digest.
     * @return The recovered validator address.
     */
    function writeCheckpoint(
        Checkpoint calldata _checkpoint,
        bytes calldata _signature
    ) public override returns (address) {
        require(_signature.length == 65, "!siglen");
        bytes32 _digest = CheckpointLib.digest(_checkpoint);
        address _validator = ECDSA.recover(_digest, _signature);
        require(_validator != address(0), "!signature");

        _checkpoints[_validator][_checkpoint.index] = SignedCheckpoint({
            checkpoint: _checkpoint,
            signature: _signature
        });

        if (
            !hasCheckpoints[_validator] ||
            _checkpoint.index > latestIndex[_validator]
        ) {
            latestIndex[_validator] = _checkpoint.index;
            hasCheckpoints[_validator] = true;
            emit LatestIndexUpdated(_validator, _checkpoint.index);
        }

        emit CheckpointWritten(
            _validator,
            _checkpoint.index,
            _checkpoint.root,
            _checkpoint.messageId
        );

        return _validator;
    }

    /**
     * @notice Writes a signed checkpoint and updates latest index if higher.
     * @param _signedCheckpoint The signed checkpoint struct.
     * @return The recovered validator address.
     */
    function writeCheckpoint(
        SignedCheckpoint calldata _signedCheckpoint
    ) external override returns (address) {
        return
            writeCheckpoint(
                _signedCheckpoint.checkpoint,
                _signedCheckpoint.signature
            );
    }

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
        override
        returns (Checkpoint memory checkpoint, bytes memory signature)
    {
        SignedCheckpoint memory sc = _checkpoints[_validator][_index];
        return (sc.checkpoint, sc.signature);
    }

    /**
     * @notice Checks whether a checkpoint exists for a validator at an index.
     * @param _validator The address of the validator.
     * @param _index The index of the checkpoint.
     * @return True if checkpoint exists, false otherwise.
     */
    function hasCheckpoint(
        address _validator,
        uint32 _index
    ) external view override returns (bool) {
        return _checkpoints[_validator][_index].signature.length == 65;
    }

    /**
     * @notice Retrieves the latest checkpoint index written by a validator.
     * @param _validator The address of the validator.
     * @return index The latest checkpoint index.
     * @return exists True if the validator has written any checkpoints.
     */
    function getLatestIndex(
        address _validator
    ) external view override returns (uint32 index, bool exists) {
        return (latestIndex[_validator], hasCheckpoints[_validator]);
    }

    /**
     * @notice Updates the latest index for the caller validator.
     * @param _index The new latest index.
     */
    function updateLatestIndex(uint32 _index) external override {
        if (!hasCheckpoints[msg.sender] || _index > latestIndex[msg.sender]) {
            latestIndex[msg.sender] = _index;
            hasCheckpoints[msg.sender] = true;
            emit LatestIndexUpdated(msg.sender, _index);
        }
    }

    /**
     * @notice Stores agent metadata for the caller validator.
     * @param _metadata Serialized metadata string.
     */
    function writeMetadata(string calldata _metadata) external override {
        validatorMetadata[msg.sender] = _metadata;
        emit MetadataWritten(msg.sender, _metadata);
    }

    /**
     * @notice Retrieves metadata for a validator.
     * @param _validator The address of the validator.
     * @return The metadata string.
     */
    function getMetadata(
        address _validator
    ) external view override returns (string memory) {
        return validatorMetadata[_validator];
    }

    /**
     * @notice Stores reorg status data for the caller validator.
     * @param _reorgData Serialized reorg status bytes.
     */
    function writeReorgStatus(bytes calldata _reorgData) external override {
        validatorReorgStatus[msg.sender] = _reorgData;
        emit ReorgStatusWritten(msg.sender, _reorgData);
    }

    /**
     * @notice Retrieves reorg status data for a validator.
     * @param _validator The address of the validator.
     * @return The reorg status bytes.
     */
    function getReorgStatus(
        address _validator
    ) external view override returns (bytes memory) {
        return validatorReorgStatus[_validator];
    }
}
