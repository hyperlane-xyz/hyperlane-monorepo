// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:   1] Suffix type
 * [   1:   5] Root index
 * [   5:  37] Origin mailbox address
 * [  37:  VS] Validator signatures (where VS := 37 + Threshold * 65 bytes)
 * [  VS:????] Suffix
 *
 * Format of suffix:
 * [   -32:   0] Merkle root
 *                OR
 * [-1056:  -32] Merkle proof
 * [  -32:    0] Message ID
 */
library MultisigIsmMetadata {
    uint8 private constant SUFFIX_TYPE_OFFSET = 0;
    uint8 private constant MERKLE_INDEX_OFFSET = 1;
    uint8 private constant ORIGIN_MAILBOX_OFFSET = 5;
    uint8 private constant SIGNATURES_OFFSET = 37;
    uint8 private constant SIGNATURE_LENGTH = 65;

    uint8 private constant SUFFIX_ROOT_OFFSET = 32;

    uint16 private constant PROOF_LENGTH = 32 * 32;
    uint8 private constant SUFFIX_ID_OFFSET = 32;
    uint16 private constant SUFFIX_PROOF_OFFSET = 32 + PROOF_LENGTH;

    enum SuffixType {
        ROOT,
        ID_AND_PROOF
    }

    function suffixType(bytes calldata _metadata)
        internal
        pure
        returns (SuffixType)
    {
        return SuffixType(uint8(_metadata[SUFFIX_TYPE_OFFSET]));
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

    function suffix(
        bytes calldata _metadata,
        uint256 offset,
        uint256 size
    ) private pure returns (bytes calldata) {
        uint256 _start = _metadata.length - offset;
        uint256 _end = _start + size;
        return _metadata[_start:_end];
    }

    /**
     * @notice Returns the merkle root of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle root of the signed checkpoint
     */
    function root(bytes calldata _metadata) internal pure returns (bytes32) {
        assert(suffixType(_metadata) == SuffixType.ROOT);
        return bytes32(suffix(_metadata, SUFFIX_ROOT_OFFSET, 32));
    }

    function id(bytes calldata _metadata) internal pure returns (bytes32) {
        assert(suffixType(_metadata) == SuffixType.ID_AND_PROOF);
        return bytes32(suffix(_metadata, SUFFIX_ID_OFFSET, 32));
    }

    function proof(bytes calldata _metadata)
        internal
        pure
        returns (bytes32[32] memory)
    {
        assert(suffixType(_metadata) == SuffixType.ID_AND_PROOF);
        return
            abi.decode(
                suffix(_metadata, SUFFIX_PROOF_OFFSET, PROOF_LENGTH),
                (bytes32[32])
            );
    }
}
