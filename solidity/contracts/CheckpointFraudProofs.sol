// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {MerkleLib} from "./libs/Merkle.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";

contract CheckpointFraudProofs {
    // copied from MerkleLib.sol
    uint256 internal constant TREE_DEPTH = 32;

    // mailbox => root => count
    mapping(address => mapping(bytes32 => uint32)) public indices;

    modifier onlyCached(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 messageId
    ) {
        bytes32 calculatedRoot = MerkleLib.branchRoot(
            messageId,
            proof,
            checkpoint.index
        );
        uint32 cachedIndex = indices[CheckpointLib.mailbox(checkpoint)][
            calculatedRoot
        ];
        require(
            cachedIndex >= checkpoint.index,
            "must prove against cached checkpoint"
        );
        _;
    }

    // must be called before proving fraud to circumvent race on mailbox insertion and merkle proof construction
    function cacheCheckpoint(address mailbox) public {
        (bytes32 root, uint32 index) = IMailbox(mailbox).latestCheckpoint();
        indices[mailbox][root] = index;
    }

    // returns whether checkpoint.index is greater than or equal to mailbox count
    function isPremature(Checkpoint calldata checkpoint)
        public
        view
        returns (bool)
    {
        return
            checkpoint.index >=
            IMailbox(CheckpointLib.mailbox(checkpoint)).count();
    }

    // returns whether actual message ID at checkpoint index on checkpoint.mailbox differs from checkpoint message ID
    function isFraudulentMessageId(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 actualMessageId
    )
        public
        view
        onlyCached(checkpoint, proof, actualMessageId)
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
        onlyCached(checkpoint, proof, checkpoint.messageId)
        returns (bool)
    {
        // modify proof to reconstruct root at checkpoint.index
        bytes32 reconstructedRoot = MerkleLib.reconstructRoot(
            checkpoint.messageId,
            proof,
            checkpoint.index
        );
        return reconstructedRoot != checkpoint.root;
    }
}
