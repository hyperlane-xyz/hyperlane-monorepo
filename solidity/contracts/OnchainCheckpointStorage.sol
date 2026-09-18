// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title OnchainCheckpointStorage
/// @notice Stores validator checkpoints on-chain for Hyperlane issue #4586
/// @dev Any account can publish checkpoints (permissionless)
/// @dev Size limits prevent gas DoS attacks
contract OnchainCheckpointStorage {
    /// @dev Maximum checkpoint data size (100KB)
    uint256 private constant MAX_CHECKPOINT_SIZE = 100 * 1024;
    /// @dev Maximum announcement size (10KB)
    uint256 private constant MAX_ANNOUNCEMENT_SIZE = 10 * 1024;
    /// @dev Maximum metadata size (1KB)
    uint256 private constant MAX_METADATA_SIZE = 1024;
    /// @dev Maximum index value
    uint32 private constant MAX_INDEX = type(uint32).max;
    /// @dev Contract version
    string private constant VERSION = "1.0.0";

    /// @dev Checkpoint data mapping
    mapping(uint32 => bytes) private checkpoints;
    /// @dev Message ID mapping
    mapping(uint32 => bytes32) private messageIds;
    /// @dev Latest checkpoint index
    uint32 private latestIndex;
    /// @dev Metadata string
    string private metadata;
    /// @dev Announcement bytes
    bytes private announcement;
    /// @dev Reorg event flag
    bytes private reorgFlag;
    /// @dev Reorg RPC responses log
    string private reorgRpcResponses;
    /// @dev Chain name for location string
    string private chainName;

    /// @dev Emitted when checkpoint is stored
    event CheckpointStored(uint32 indexed index, bytes32 messageId, uint256 dataSize);
    /// @dev Emitted when latest index updates
    event LatestIndexUpdated(uint32 indexed newIndex);
    /// @dev Emitted when metadata updates
    event MetadataUpdated(uint256 dataSize);
    /// @dev Emitted when announcement updates
    event AnnouncementUpdated(uint256 dataSize);
    /// @dev Emitted when reorg status updates
    event ReorgStatusUpdated(uint256 dataSize);
    /// @dev Emitted when reorg RPC responses update
    event ReorgRpcResponsesUpdated(uint256 dataSize);

    /// @param chainName The Hyperlane chain name (e.g., "ethereum")
    constructor(string memory chainName) {
        chainName = chainName;
        latestIndex = 0;
    }

    /// @notice Stores a checkpoint with message ID
    /// @param index Checkpoint index (0 to MAX_INDEX)
    /// @param messageId Associated message ID
    /// @param serializedCheckpoint Serialized checkpoint data (JSON bytes)
    function storeCheckpoint(
        uint32 index,
        bytes32 messageId,
        bytes memory serializedCheckpoint
    ) external {
        require(index <= MAX_INDEX, "OnchainCheckpointStorage: index exceeds maximum");
        require(serializedCheckpoint.length <= MAX_CHECKPOINT_SIZE, "OnchainCheckpointStorage: checkpoint data exceeds maximum size");
        checkpoints[index] = serializedCheckpoint;
        messageIds[index] = messageId;
        if (index > latestIndex) {
            latestIndex = index;
            emit LatestIndexUpdated(index);
        }
        emit CheckpointStored(index, messageId, serializedCheckpoint.length);
    }

    /// @notice Updates the latest checkpoint index
    /// @param index New latest index (only updates if greater)
    function setLatestIndex(uint32 index) external {
        require(index <= MAX_INDEX, "OnchainCheckpointStorage: index exceeds maximum");
        if (index > latestIndex) {
            latestIndex = index;
            emit LatestIndexUpdated(index);
        }
    }

    /// @notice Stores validator metadata (JSON string)
    /// @param serializedMetadata Serialized metadata string
    function storeMetadata(string memory serializedMetadata) external {
        require(bytes(serializedMetadata).length <= MAX_METADATA_SIZE, "OnchainCheckpointStorage: metadata exceeds maximum size");
        metadata = serializedMetadata;
        emit MetadataUpdated(bytes(serializedMetadata).length);
    }

    /// @notice Stores a signed announcement (JSON bytes)
    /// @param serializedAnnouncement Serialized announcement data
    function storeAnnouncement(bytes memory serializedAnnouncement) external {
        require(serializedAnnouncement.length <= MAX_ANNOUNCEMENT_SIZE, "OnchainCheckpointStorage: announcement data exceeds maximum size");
        announcement = serializedAnnouncement;
        emit AnnouncementUpdated(serializedAnnouncement.length);
    }

    /// @notice Stores a reorg event (JSON bytes)
    /// @param serializedReorgEvent Serialized reorg event data
    function storeReorgStatus(bytes memory serializedReorgEvent) external {
        require(serializedReorgEvent.length <= MAX_CHECKPOINT_SIZE, "OnchainCheckpointStorage: reorg data exceeds maximum size");
        reorgFlag = serializedReorgEvent;
        emit ReorgStatusUpdated(serializedReorgEvent.length);
    }

    /// @notice Stores reorg RPC responses log
    /// @param log Log message to store
    function storeReorgRpcResponses(string memory log) external {
        reorgRpcResponses = log;
        emit ReorgRpcResponsesUpdated(bytes(log).length);
    }

    /// @notice Retrieves checkpoint by index
    /// @param index Checkpoint index
    /// @return Serialized checkpoint data (JSON bytes)
    function getCheckpoint(uint32 index) external view returns (bytes memory) {
        return checkpoints[index];
    }

    /// @notice Retrieves checkpoint and message ID together (gas-efficient batch read)
    /// @param index Checkpoint index
    /// @return checkpointData Serialized checkpoint data
    /// @return messageId Message ID bytes32
    function getCheckpointWithMessageId(uint32 index) external view returns (bytes memory, bytes32) {
        return (checkpoints[index], messageIds[index]);
    }

    /// @notice Gets message ID for a checkpoint
    /// @param index Checkpoint index
    /// @return Message ID bytes32 (zero if not found)
    function getMessageId(uint32 index) external view returns (bytes32) {
        return messageIds[index];
    }

    /// @notice Gets latest checkpoint index
    /// @return Latest index (0 if no checkpoints stored)
    function getLatestIndex() external view returns (uint32) {
        return latestIndex;
    }

    /// @notice Gets metadata
    /// @return Metadata string (JSON)
    function getMetadata() external view returns (string memory) {
        return metadata;
    }

    /// @notice Gets announcement
    /// @return Serialized announcement data (JSON bytes)
    function getAnnouncement() external view returns (bytes memory) {
        return announcement;
    }

    /// @notice Gets reorg flag
    /// @return Serialized reorg event data (JSON bytes)
    function getReorgFlag() external view returns (bytes memory) {
        return reorgFlag;
    }

    /// @notice Gets reorg RPC responses
    /// @return Log message
    function getReorgRpcResponses() external view returns (string memory) {
        return reorgRpcResponses;
    }

    /// @notice Returns contract version
    /// @return Version string
    function version() external pure returns (string memory) {
        return VERSION;
    }

    /// @notice Returns max checkpoint size limit
    /// @return Maximum size in bytes
    function maxCheckpointSize() external pure returns (uint256) {
        return MAX_CHECKPOINT_SIZE;
    }

    /// @notice Returns max announcement size limit
    /// @return Maximum size in bytes
    function maxAnnouncementSize() external pure returns (uint256) {
        return MAX_ANNOUNCEMENT_SIZE;
    }

    /// @notice Returns the location string for this storage
    /// @dev Format: onchain://<chainName>/<contractAddress>
    /// @return The location string in parseable format
    function getLocation() external view returns (string memory) {
        return string(
            abi.encodePacked(
                "onchain://",
                chainName,
                "/",
                Strings.toHexString(uint256(uint160(address(this))), 32)
            )
        );
    }
}
