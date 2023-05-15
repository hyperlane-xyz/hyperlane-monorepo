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
 * @title MerkleRootMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * a quorum of signatures on some root J and merkle proof of message I in J.
 * @dev Implement and use if you want strong censorship resistance guarantees.
 * @dev May be adapted in future to support batch message verification against a single root.
 */
abstract contract AbstractMerkleRootMultisigIsm is AbstractMultisigIsm {
    // ============ Constants ============

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
