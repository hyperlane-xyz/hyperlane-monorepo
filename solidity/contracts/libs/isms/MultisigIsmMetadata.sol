// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:   4] Root index
 * [   4:  36] Origin mailbox address
 * [  36:  VS] Validator signatures (where VS := 36 + Threshold * 65 bytes)
 * [  VS:????] Suffix
 *
 * Format of suffix:
 * [  -33:  -1] Merkle root
 * [   -1:   0] SuffixType.ROOT
 *                  OR
 * [-1056: -33] Merkle proof
 * [  -33:  -1] Message ID
 * [   -1:   0] SuffixType.PROOF_AND_ID
 */
library MultisigIsmMetadata {
    uint8 private constant MERKLE_INDEX_OFFSET = 0;
    uint8 private constant ORIGIN_MAILBOX_OFFSET = 4;
    uint8 private constant SIGNATURES_OFFSET = 36;
    uint8 private constant SIGNATURE_LENGTH = 65;

    uint8 private constant SUFFIX_TYPE_OFFSET = 0;
    uint8 private constant SUFFIX_ROOT_OFFSET = 1;

    uint8 private constant SUFFIX_ID_OFFSET = 1;
    uint8 private constant SUFFIX_PROOF_OFFSET = 33;

    enum SuffixType {
        ROOT,
        PROOF_AND_ID
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
        uint256 _end = _metadata.length - offset;
        uint256 _start = _end - size;
        return _metadata[_start:_end];
    }

    function suffixType(bytes calldata _metadata)
        internal
        pure
        returns (SuffixType)
    {
        return
            SuffixType(uint8(bytes1(suffix(_metadata, SUFFIX_TYPE_OFFSET, 1))));
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

    function signedMessageId(bytes calldata _metadata)
        internal
        pure
        returns (bytes32)
    {
        assert(suffixType(_metadata) == SuffixType.PROOF_AND_ID);
        return bytes32(suffix(_metadata, SUFFIX_ID_OFFSET, 32));
    }

    function merkleProof(bytes calldata _metadata)
        internal
        pure
        returns (bytes32[32] memory)
    {
        assert(suffixType(_metadata) == SuffixType.PROOF_AND_ID);
        return
            abi.decode(
                suffix(_metadata, SUFFIX_PROOF_OFFSET, 32 * 32),
                (bytes32[32])
            );
    }
}
