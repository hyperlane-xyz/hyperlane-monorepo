// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Merkle root
 * [  32:  36] Root index
 * [  36:  68] Origin mailbox address
 * [  68:  90] Message ID (leaf at root index in merkle tree)
 * [  90:????] Validator signatures, 65 bytes each, length == Threshold
 * [????:????] (Optional) Merkle proof
 */
library MultisigIsmMetadata {
    uint256 private constant MERKLE_ROOT_OFFSET = 0;
    uint256 private constant MERKLE_INDEX_OFFSET = 32;
    uint256 private constant ORIGIN_MAILBOX_OFFSET = 36;
    uint256 private constant MESSAGE_ID_OFFSET = 68;
    uint256 private constant SIGNATURES_OFFSET = 90;
    uint256 private constant SIGNATURE_LENGTH = 65;
    uint256 private constant PROOF_LENGTH = 32 * 32;

    /**
     * @notice Returns the merkle root of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle root of the signed checkpoint
     */
    function root(bytes calldata _metadata) internal pure returns (bytes32) {
        return bytes32(_metadata[MERKLE_ROOT_OFFSET:MERKLE_INDEX_OFFSET]);
    }

    /**
     * @notice Returns the index of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Index of the signed checkpoint
     */
    function index(bytes calldata _metadata) internal pure returns (uint32) {
        return
            uint32(
                bytes4(_metadata[MERKLE_INDEX_OFFSET:ORIGIN_MAILBOX_OFFSET])
            );
    }

    /**
     * @notice Returns the origin mailbox of the signed checkpoint as bytes32.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Origin mailbox of the signed checkpoint as bytes32
     */
    function originMailbox(bytes calldata _metadata)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_metadata[ORIGIN_MAILBOX_OFFSET:MESSAGE_ID_OFFSET]);
    }

    function messageId(bytes calldata _metadata)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_metadata[MESSAGE_ID_OFFSET:SIGNATURES_OFFSET]);
    }

    function proofOffset(uint256 threshold) private pure returns (uint256) {
        return SIGNATURES_OFFSET + (threshold * SIGNATURE_LENGTH);
    }

    function hasProof(bytes calldata _metadata, uint256 threshold)
        internal
        pure
        returns (bool)
    {
        return _metadata.length > proofOffset(threshold);
    }

    /**
     * @notice Returns the merkle proof branch of the message.
     * @dev This appears to be more gas efficient than returning a calldata
     * slice and using that.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @param _threshold Used to determine offset from signatures.
     * @return Merkle proof branch of the message.
     */
    function proof(bytes calldata _metadata, uint256 _threshold)
        internal
        pure
        returns (bytes32[32] memory)
    {
        return abi.decode(_metadata[proofOffset(_threshold):], (bytes32[32]));
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
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = SIGNATURES_OFFSET + (_index * SIGNATURE_LENGTH);
        uint256 _end = _start + SIGNATURE_LENGTH;
        return _metadata[_start:_end];
    }
}
