// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {MerkleRootMultisigIsmMetadata} from "../../libs/isms/MerkleRootMultisigIsmMetadata.sol";
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
abstract contract AbstractMerkleRootMultisigIsm is AbstractMultisigIsm {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MERKLE_ROOT_MULTISIG);

    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function digest(bytes calldata _metadata, bytes calldata _message)
        internal
        pure
        override
        returns (bytes32)
    {
        // We verify a merkle proof of (messageId, index) I to compute root J
        bytes32 _root = MerkleLib.branchRoot(
            Message.id(_message),
            MerkleRootMultisigIsmMetadata.proof(_metadata),
            Message.nonce(_message)
        );
        // We provide (messageId, index) J in metadata for digest derivation
        return
            CheckpointLib.digest(
                Message.origin(_message),
                MerkleRootMultisigIsmMetadata.originMailbox(_metadata),
                _root,
                MerkleRootMultisigIsmMetadata.index(_metadata),
                MerkleRootMultisigIsmMetadata.messageId(_metadata)
            );
    }

    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        virtual
        override
        returns (bytes memory signature)
    {
        return MerkleRootMultisigIsmMetadata.signatureAt(_metadata, _index);
    }
}
