// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisig} from "./AbstractMultisigIsm.sol";
import {MerkleRootMultisigIsmMetadata} from "../../isms/libs/MerkleRootMultisigIsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {MerkleLib} from "../../libs/Merkle.sol";
import {CheckpointLib} from "../../libs/CheckpointLib.sol";

/**
 * @title `AbstractMerkleRootMultisigIsm` — multi-sig ISM with the validators-censorship resistance guarantee.
 * @notice This ISM allows using a newer signed checkpoint (say #33) to prove existence of an older message (#22) in the validators' MerkleTree.
 * This guarantees censorship resistance as validators cannot hide a message
 * by refusing to sign its checkpoint but later signing a checkpoint for a newer message.
 * If validators decide to censor a message, they are left with only one option — to not produce checkpoints at all.
 * Otherwise, the very next signed checkpoint (#33) can be used by any relayer to prove the previous message inclusion using this ISM.
 * This is censorship resistance is missing in the sibling implementation `AbstractMessageIdMultisigIsm`,
 * since it can only verify messages having the corresponding checkpoints.
 * @dev Provides the default implementation of verifying signatures over a checkpoint and the message inclusion in that checkpoint.
 * This abstract contract can be overridden for customizing the `validatorsAndThreshold()` (static or dynamic).
 * @dev May be adapted in future to support batch message verification against a single root.
 */
abstract contract AbstractMerkleRootMultisigIsm is AbstractMultisig {
    using MerkleRootMultisigIsmMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    /**
     * @inheritdoc AbstractMultisig
     */
    function digest(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure virtual override returns (bytes32) {
        require(
            _metadata.messageIndex() <= _metadata.signedIndex(),
            "Invalid merkle index metadata"
        );
        // We verify a merkle proof of (messageId, index) I to compute root J
        bytes32 _signedRoot = MerkleLib.branchRoot(
            _message.id(),
            _metadata.proof(),
            _metadata.messageIndex()
        );
        // We provide (messageId, index) J in metadata for digest derivation
        return
            CheckpointLib.digest(
                _message.origin(),
                _metadata.originMerkleTreeHook(),
                _signedRoot,
                _metadata.signedIndex(),
                _metadata.signedMessageId()
            );
    }

    /**
     * @inheritdoc AbstractMultisig
     */
    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure virtual override returns (bytes calldata) {
        return _metadata.signatureAt(_index);
    }

    /**
     * @inheritdoc AbstractMultisig
     */
    function signatureCount(
        bytes calldata _metadata
    ) public pure override returns (uint256) {
        return _metadata.signatureCount();
    }
}
