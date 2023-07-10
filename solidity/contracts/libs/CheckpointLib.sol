// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "./TypeCasts.sol";
import {LegacyCheckpointLib} from "./LegacyCheckpointLib.sol";

struct Checkpoint {
    uint32 origin;
    bytes32 originMailbox;
    bytes32 root;
    uint32 index;
    bytes32 messageId;
}

library CheckpointLib {
    /**
     * @notice Returns the digest validators are expected to sign when signing checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @param _checkpointRoot The root of the checkpoint.
     * @param _checkpointIndex The index of the checkpoint.
     * @param _messageId The message ID of the checkpoint.
     * @dev Message ID must match leaf content of checkpoint root at index.
     * @return The digest of the checkpoint.
     */
    function digest(
        uint32 _origin,
        bytes32 _originMailbox,
        bytes32 _checkpointRoot,
        uint32 _checkpointIndex,
        bytes32 _messageId
    ) internal pure returns (bytes32) {
        bytes32 _domainHash = domainHash(_origin, _originMailbox);
        // TODO: remove ECDSA specific code
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        _checkpointRoot,
                        _checkpointIndex,
                        _messageId
                    )
                )
            );
    }

    /**
     * @notice Returns the digest validators are expected to sign when signing checkpoints.
     * @param checkpoint The checkpoint (struct) to hash.
     * @return The digest of the checkpoint.
     */
    function digest(Checkpoint calldata checkpoint)
        internal
        pure
        returns (bytes32)
    {
        return
            digest(
                checkpoint.origin,
                checkpoint.originMailbox,
                checkpoint.root,
                checkpoint.index,
                checkpoint.messageId
            );
    }

    /**
     * @notice Returns the mailbox address for the checkpoint.
     * @param checkpoint The checkpoint (struct).
     * @return The (20 byte EVM) address of the mailbox.
     */
    function mailbox(Checkpoint calldata checkpoint)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes32ToAddress(checkpoint.originMailbox);
    }

    /**
     * @notice Returns the domain hash that validators are expected to use
     * when signing checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @return The domain hash.
     */
    function domainHash(uint32 _origin, bytes32 _originMailbox)
        internal
        pure
        returns (bytes32)
    {
        // Including the origin mailbox address in the signature allows the slashing
        // protocol to enroll multiple mailboxes. Otherwise, a valid signature for
        // mailbox A would be indistinguishable from a fraudulent signature for mailbox
        // B.
        // The slashing protocol should slash if validators sign attestations for
        // anything other than a whitelisted mailbox.
        return
            keccak256(abi.encodePacked(_origin, _originMailbox, "HYPERLANE"));
    }
}
