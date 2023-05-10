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
 * @title MultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
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
        bytes32 root = MerkleLib.branchRoot(
            Message.id(_message),
            MerkleRootMultisigIsmMetadata.proof(_metadata),
            Message.nonce(_message)
        );
        return
            CheckpointLib.digest(
                Message.origin(_message),
                MerkleRootMultisigIsmMetadata.originMailbox(_metadata),
                root,
                MerkleRootMultisigIsmMetadata.index(_metadata),
                MerkleRootMultisigIsmMetadata.signedMessageId(_metadata)
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
