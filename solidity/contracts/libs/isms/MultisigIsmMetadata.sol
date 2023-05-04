// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:   4] Root index
 * [   4:  36] Origin mailbox address
 * [  36:  37] Merkle type
 * [  36:  VS] Validator signatures (where VS = 36 + Threshold * 65 bytes)
 *
 * [  VS:????] Merkle root
 *                OR
 * [  VS:????] (Message ID, Merkle proof)
 */
library MultisigIsmMetadata {
    uint8 private constant MERKLE_INDEX_OFFSET = 0;
    uint8 private constant ORIGIN_MAILBOX_OFFSET = 4;
    uint8 private constant MERKLE_TYPE_OFFSET = 36;
    uint8 private constant SIGNATURES_OFFSET = 37;
    uint8 private constant SIGNATURE_LENGTH = 65;
    uint16 private constant PROOF_LENGTH = 32 * 32;

    enum MerkleType {
        ROOT,
        ID_AND_PROOF
    }

    /**
     * @notice Returns the index of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Index of the signed checkpoint
     */
    function index(bytes calldata _metadata) internal pure returns (uint32) {
        return
            uint32(
                bytes4(_metadata[MERKLE_INDEX_OFFSET:MERKLE_INDEX_OFFSET + 4])
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
        return
            bytes32(
                _metadata[ORIGIN_MAILBOX_OFFSET:ORIGIN_MAILBOX_OFFSET + 32]
            );
    }

    function merkleType(bytes calldata _metadata)
        internal
        pure
        returns (MerkleType)
    {
        return MerkleType(uint8(_metadata[MERKLE_TYPE_OFFSET]));
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

    /**
     * @notice Returns the merkle root of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle root of the signed checkpoint
     */
    function root(bytes calldata _metadata) internal pure returns (bytes32) {
        assert(merkleType(_metadata) == MerkleType.ROOT);
        return bytes32(_metadata[_metadata.length - 32:]);
    }

    function idAndProof(bytes calldata _metadata)
        internal
        pure
        returns (bytes32, bytes32[32] memory)
    {
        assert(merkleType(_metadata) == MerkleType.ID_AND_PROOF);
        return
            abi.decode(
                _metadata[_metadata.length - (PROOF_LENGTH + 32):],
                (bytes32, bytes32[32])
            );
    }
}
