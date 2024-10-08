// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Origin merkle tree address
 * [  32:  64] Signed checkpoint root
 * [  64:  68] Signed checkpoint index
 * [  68:????] Validator signatures (length := threshold * 65)
 */
library RpcMultisigIsmMetadata {
    uint8 private constant ORIGIN_MERKLE_TREE_OFFSET = 0;
    uint8 private constant SIGNATURES_OFFSET = 32;
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

    /**
     * @notice Returns the number of signatures in the metadata.
     * @param _metadata ABI encoded MessageId Multisig ISM metadata.
     * @return The number of signatures in the metadata.
     */
    function signatureCount(
        bytes calldata _metadata
    ) internal pure returns (uint256) {
        uint256 signatures = _metadata.length - SIGNATURES_OFFSET;
        require(
            signatures % SIGNATURE_LENGTH == 0,
            "Invalid signatures length"
        );
        return signatures / SIGNATURE_LENGTH;
    }
}
