// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Origin merkle tree address
 * [  32:  36] Index of message ID in merkle tree
 * [  36:  68] Signed checkpoint message ID
 * [  68:1092] Merkle proof
 * [1092:1096] Signed checkpoint index (computed from proof and index)
 * [1096:????] Validator signatures (length := threshold * 65)
 */
library MerkleRootMultisigIsmMetadata {
    uint8 private constant ORIGIN_MERKLE_TREE_OFFSET = 0;
    uint8 private constant MESSAGE_INDEX_OFFSET = 32;
    uint8 private constant MESSAGE_ID_OFFSET = 36;
    uint8 private constant MERKLE_PROOF_OFFSET = 68;
    uint16 private constant MERKLE_PROOF_LENGTH = 32 * 32;
    uint16 private constant SIGNED_INDEX_OFFSET = 1092;
    uint16 private constant SIGNATURES_OFFSET = 1096;
    uint8 private constant SIGNATURE_LENGTH = 65;

    /**
     * @notice Returns the origin merkle tree hook of the signed checkpoint as bytes32.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Origin merkle tree hook of the signed checkpoint as bytes32
     */
    function originMerkleTreeHook(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        return
            bytes32(
                _metadata[ORIGIN_MERKLE_TREE_OFFSET:ORIGIN_MERKLE_TREE_OFFSET +
                    32]
            );
    }

    /**
     * @notice Returns the index of the message being proven.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Index of the target message in the merkle tree.
     */
    function messageIndex(
        bytes calldata _metadata
    ) internal pure returns (uint32) {
        return
            uint32(
                bytes4(_metadata[MESSAGE_INDEX_OFFSET:MESSAGE_INDEX_OFFSET + 4])
            );
    }

    /**
     * @notice Returns the index of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Index of the signed checkpoint
     */
    function signedIndex(
        bytes calldata _metadata
    ) internal pure returns (uint32) {
        return
            uint32(
                bytes4(_metadata[SIGNED_INDEX_OFFSET:SIGNED_INDEX_OFFSET + 4])
            );
    }

    /**
     * @notice Returns the message ID of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Message ID of the signed checkpoint
     */
    function signedMessageId(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        return bytes32(_metadata[MESSAGE_ID_OFFSET:MESSAGE_ID_OFFSET + 32]);
    }

    /**
     * @notice Returns the merkle proof branch of the message.
     * @dev This appears to be more gas efficient than returning a calldata
     * slice and using that.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle proof branch of the message.
     */
    function proof(
        bytes calldata _metadata
    ) internal pure returns (bytes32[32] memory) {
        return
            abi.decode(
                _metadata[MERKLE_PROOF_OFFSET:MERKLE_PROOF_OFFSET +
                    MERKLE_PROOF_LENGTH],
                (bytes32[32])
            );
    }

    /**
     * @notice Returns the validator ECDSA signature at `_index`.
     * @dev Assumes signatures are sorted by validator
     * @dev Assumes `_metadata` encodes `threshold` signatures.
     * @dev Assumes `_index` is less than `threshold`
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @param _index The index of the signature to return.
     * @return The validator ECDSA signature at `_index`.
     */
    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure returns (bytes calldata) {
        uint256 _start = SIGNATURES_OFFSET + (_index * SIGNATURE_LENGTH);
        uint256 _end = _start + SIGNATURE_LENGTH;
        return _metadata[_start:_end];
    }
}
