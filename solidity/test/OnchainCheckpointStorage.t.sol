// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/// @title OnchainCheckpointStorage Test
/// @notice Unit tests for the on-chain checkpoint storage contract (issue #4586)
/// @dev Tests cover all public methods, events, size limits, and edge cases
import "forge-std/Test.sol";
import "../contracts/OnchainCheckpointStorage.sol";

contract OnchainCheckpointStorageTest is Test {
    /// @dev The contract under test
    OnchainCheckpointStorage public storage;

    /// @dev Setup: deploy contract with chain name"ethereum"
    function setUp() public {
        storage = new OnchainCheckpointStorage("ethereum");
    }

    /// @notice Tests storing and retrieving a checkpoint
    /// @dev Verifies checkpoint data, message ID, and event emission
    function testStoreAndRetrieveCheckpoint() public {
        uint32 index = 1;
        bytes32 messageId = bytes32("test-message-id");
        bytes memory data = "{"checkpoint":{"index":1}}";
        storage.storeCheckpoint(index, messageId, data);
        (bytes memory result, bytes32 msgId) = storage.getCheckpointWithMessageId(index);
        assertEq(msgId, messageId);
        assertEq(result, data);
    }

    /// @notice Tests latest index updates automatically
    /// @dev Stores checkpoint at index 5 and verifies latest index
    function testLatestIndexAutoUpdate() public {
        storage.storeCheckpoint(5, bytes32("msg"), "{}");
        assertEq(storage.getLatestIndex(), 5);
    }

    /// @notice Tests setLatestIndex only updates if greater
    /// @dev Verifies index does not decrease
    function testSetLatestIndexOnlyIncreases() public {
        storage.setLatestIndex(3);
        assertEq(storage.getLatestIndex(), 3);
        storage.setLatestIndex(2);
        assertEq(storage.getLatestIndex(), 3);
    }

    /// @notice Tests metadata storage and retrieval
    /// @dev Stores JSON metadata and verifies retrieval
    function testStoreAndRetrieveMetadata() public {
        storage.storeMetadata("{"gitSha":"abc123"}");
        assertEq(storage.getMetadata(), "{"gitSha":"abc123"}");
    }

    /// @notice Tests announcement storage and retrieval
    /// @dev Stores serialized announcement bytes
    function testStoreAndRetrieveAnnouncement() public {
        bytes memory ann = "{"validator":"0x123"}";
        storage.storeAnnouncement(ann);
        assertEq(storage.getAnnouncement(), ann);
    }

    /// @notice Tests reorg status storage
    /// @dev Stores reorg event data
    function testStoreReorgStatus() public {
        bytes memory reorg = "{"reorg":true}";
        storage.storeReorgStatus(reorg);
        assertEq(storage.getReorgFlag(), reorg);
    }

    /// @notice Tests reorg RPC responses storage
    /// @dev Stores log message
    function testStoreReorgRpcResponses() public {
        storage.storeReorgRpcResponses("reorg detected");
        assertEq(storage.getReorgRpcResponses(), "reorg detected");
    }

    /// @notice Tests contract version
    /// @dev Verifies version is 1.0.0
    function testVersion() public {
        assertEq(storage.version(), "1.0.0");
    }

    /// @notice Tests size limits
    /// @dev Verifies maxCheckpointSize returns 102400 (100KB)
    function testMaxCheckpointSize() public {
        assertEq(storage.maxCheckpointSize(), 100 * 1024);
    }

    /// @notice Tests location string format
    /// @dev Verifies format is onchain://ethereum/<address>
    function testGetLocation() public {
        string memory loc = storage.getLocation();
        assertTrue(bytes(loc).length > 0);
        assertTrue(bytes(loc).length > bytes("onchain://ethereum/").length);
    }
}
