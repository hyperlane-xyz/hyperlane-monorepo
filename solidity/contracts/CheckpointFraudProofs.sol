// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {Checkpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {MerkleLib, TREE_DEPTH} from "./libs/Merkle.sol";
import {MerkleTreeHook} from "./hooks/MerkleTreeHook.sol";

import {PackageVersioned} from "./PackageVersioned.sol";

struct StoredIndex {
    uint32 index;
    bool exists;
}

contract CheckpointFraudProofs is PackageVersioned {
    using CheckpointLib for Checkpoint;
    using Address for address;

    mapping(address merkleTree => mapping(bytes32 root => StoredIndex index))
        public storedCheckpoints;

    function storedCheckpointContainsMessage(
        address merkleTree,
        uint32 index,
        bytes32 messageId,
        bytes32[TREE_DEPTH] calldata proof
    ) public view returns (bool) {
        bytes32 root = MerkleLib.branchRoot(messageId, proof, index);
        StoredIndex storage storedIndex = storedCheckpoints[merkleTree][root];
        return storedIndex.exists && storedIndex.index >= index;
    }

    modifier onlyMessageInStoredCheckpoint(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 messageId
    ) {
        require(
            storedCheckpointContainsMessage(
                checkpoint.merkleTreeAddress(),
                checkpoint.index,
                messageId,
                proof
            ),
            "message must be member of stored checkpoint"
        );
        _;
    }

    function isLocal(
        Checkpoint calldata checkpoint
    ) public view returns (bool) {
        address merkleTree = checkpoint.merkleTreeAddress();
        return
            merkleTree.isContract() &&
            MerkleTreeHook(merkleTree).localDomain() == checkpoint.origin;
    }

    modifier onlyLocal(Checkpoint calldata checkpoint) {
        require(isLocal(checkpoint), "must be local checkpoint");
        _;
    }

    /**
     *  @notice Stores the latest checkpoint of the provided merkle tree hook
     *  @param merkleTree Address of the merkle tree hook to store the latest checkpoint of.
     *  @dev Must be called before proving fraud to circumvent race on message insertion and merkle proof construction.
     */
    function storeLatestCheckpoint(
        address merkleTree
    ) external returns (bytes32 root, uint32 index) {
        (root, index) = MerkleTreeHook(merkleTree).latestCheckpoint();
        storedCheckpoints[merkleTree][root] = StoredIndex(index, true);
    }

    /**
     *  @notice Checks whether the provided checkpoint is premature (fraud).
     *  @param checkpoint Checkpoint to check.
     *  @dev Checks whether checkpoint.index is greater than or equal to mailbox count
     *  @return Whether the provided checkpoint is premature.
     */
    function isPremature(
        Checkpoint calldata checkpoint
    ) public view onlyLocal(checkpoint) returns (bool) {
        // count is the number of messages in the mailbox (i.e. the latest index + 1)
        uint32 count = MerkleTreeHook(checkpoint.merkleTreeAddress()).count();

        // index >= count is equivalent to index > latest index
        return checkpoint.index >= count;
    }

    /**
     *  @notice Checks whether the provided checkpoint has a fraudulent message ID.
     *  @param checkpoint Checkpoint to check.
     *  @param proof Merkle proof of the actual message ID at checkpoint.index on checkpoint.merkleTree
     *  @param actualMessageId Actual message ID at checkpoint.index on checkpoint.merkleTree
     *  @dev Must produce proof of inclusion for actualMessageID against some stored checkpoint.
     *  @return Whether the provided checkpoint has a fraudulent message ID.
     */
    function isFraudulentMessageId(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 actualMessageId
    )
        public
        view
        onlyLocal(checkpoint)
        onlyMessageInStoredCheckpoint(checkpoint, proof, actualMessageId)
        returns (bool)
    {
        return actualMessageId != checkpoint.messageId;
    }

    /**
     *  @notice Checks whether the provided checkpoint has a fraudulent root.
     *  @param checkpoint Checkpoint to check.
     *  @param proof Merkle proof of the checkpoint.messageId at checkpoint.index on checkpoint.merkleTree
     *  @dev Must produce proof of inclusion for checkpoint.messageId against some stored checkpoint.
     *  @return Whether the provided checkpoint has a fraudulent message ID.
     */
    function isFraudulentRoot(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof
    )
        public
        view
        onlyLocal(checkpoint)
        onlyMessageInStoredCheckpoint(checkpoint, proof, checkpoint.messageId)
        returns (bool)
    {
        // proof of checkpoint.messageId at checkpoint.index is the list of siblings from the leaf node to some stored root
        // once verifying the proof, we can reconstruct the specific root at checkpoint.index by replacing siblings greater
        // than the index (right subtrees) with zeroes
        bytes32 root = MerkleLib.reconstructRoot(
            checkpoint.messageId,
            proof,
            checkpoint.index
        );
        return root != checkpoint.root;
    }
}
