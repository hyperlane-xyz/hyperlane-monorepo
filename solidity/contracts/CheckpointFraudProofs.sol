// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";

contract CheckpointFraudProofs {
    // copied from MerkleLib.sol
    uint256 internal constant TREE_DEPTH = 32;

    mapping(address => mapping(bytes32 => uint32)) public storedCheckpoint;

    modifier memberOfStoredCheckpoint(
        bytes32 messageId,
        address mailbox,
        uint32 index,
        bytes32[TREE_DEPTH] calldata proof
    ) {
        bytes32 root = MerkleLib.branchRoot(messageId, proof, index);
        uint32 storedIndex = storedCheckpoint[mailbox][root];
        require(
            storedIndex >= index,
            "message must be member of stored checkpoint"
        );
        _;
    }

    modifier onlyLocalCheckpoint(Checkpoint calldata checkpoint) {
        uint32 mailboxDomain = IMailbox(CheckpointLib.mailbox(checkpoint))
            .localDomain();
        require(checkpoint.origin == mailboxDomain, "must be local checkpoint");
        _;
    }

    // must be called before proving fraud to circumvent race on mailbox insertion and merkle proof construction
    function storeLatestCheckpoint(address mailbox) public {
        (bytes32 root, uint32 index) = IMailbox(mailbox).latestCheckpoint();
        storedCheckpoint[mailbox][root] = index;
    }

    // returns whether checkpoint.index is greater than or equal to mailbox count
    function isPremature(
        Checkpoint calldata checkpoint
    ) public view onlyLocalCheckpoint(checkpoint) returns (bool) {
        // count is the number of messages in the mailbox (i.e. the latest index + 1)
        uint32 count = IMailbox(CheckpointLib.mailbox(checkpoint)).count();

        // index >= count is equivalent to index > latest index
        return checkpoint.index >= count;
    }

    // returns whether actual message ID at checkpoint index on checkpoint.mailbox differs from checkpoint message ID
    function isFraudulentMessageId(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 actualMessageId
    )
        public
        view
        onlyLocalCheckpoint(checkpoint)
        memberOfStoredCheckpoint(
            actualMessageId,
            CheckpointLib.mailbox(checkpoint),
            checkpoint.index,
            proof
        )
        returns (bool)
    {
        return actualMessageId != checkpoint.messageId;
    }

    // returns whether actual root at checkpoint index on checkpoint.mailbox differs from checkpoint root
    function isFraudulentRoot(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof
    )
        public
        view
        onlyLocalCheckpoint(checkpoint)
        memberOfStoredCheckpoint(
            checkpoint.messageId,
            CheckpointLib.mailbox(checkpoint),
            checkpoint.index,
            proof
        )
        returns (bool)
    {
        // proof of checkpoint.messageId at checkpoint.index is the list of siblings from the leaf node to some stored root
        // once verifying the proof, we can reconstruct the specific root at checkpoint.index by replacing siblings greater
        // than the index (right subtrees) with zeroes
        bytes32 reconstructedRoot = MerkleLib.reconstructRoot(
            checkpoint.messageId,
            proof,
            checkpoint.index
        );
        return reconstructedRoot != checkpoint.root;
    }
}
