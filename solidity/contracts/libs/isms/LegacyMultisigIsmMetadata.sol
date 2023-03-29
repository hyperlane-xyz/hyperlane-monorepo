// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Merkle root
 * [  32:  36] Root index
 * [  36:  68] Origin mailbox address
 * [  68:1092] Merkle proof
 * [1092:1093] Threshold
 * [1093:????] Validator signatures, 65 bytes each, length == Threshold
 * [????:????] Addresses of the entire validator set, left padded to bytes32
 */
library LegacyMultisigIsmMetadata {
    uint256 private constant MERKLE_ROOT_OFFSET = 0;
    uint256 private constant MERKLE_INDEX_OFFSET = 32;
    uint256 private constant ORIGIN_MAILBOX_OFFSET = 36;
    uint256 private constant MERKLE_PROOF_OFFSET = 68;
    uint256 private constant THRESHOLD_OFFSET = 1092;
    uint256 private constant SIGNATURES_OFFSET = 1093;
    uint256 private constant SIGNATURE_LENGTH = 65;

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
        return bytes32(_metadata[ORIGIN_MAILBOX_OFFSET:MERKLE_PROOF_OFFSET]);
    }

    /**
     * @notice Returns the merkle proof branch of the message.
     * @dev This appears to be more gas efficient than returning a calldata
     * slice and using that.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle proof branch of the message.
     */
    function proof(bytes calldata _metadata)
        internal
        pure
        returns (bytes32[32] memory)
    {
        return
            abi.decode(
                _metadata[MERKLE_PROOF_OFFSET:THRESHOLD_OFFSET],
                (bytes32[32])
            );
    }

    /**
     * @notice Returns the number of required signatures. Verified against
     * the commitment stored in the module.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The number of required signatures.
     */
    function threshold(bytes calldata _metadata) internal pure returns (uint8) {
        return uint8(bytes1(_metadata[THRESHOLD_OFFSET:SIGNATURES_OFFSET]));
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
     * @notice Returns the validator address at `_index`.
     * @dev Assumes `_index` is less than the number of validators
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @param _index The index of the validator to return.
     * @return The validator address at `_index`.
     */
    function validatorAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        returns (address)
    {
        // Validator addresses are left padded to bytes32 in order to match
        // abi.encodePacked(address[]).
        uint256 _start = _validatorsOffset(_metadata) + (_index * 32) + 12;
        uint256 _end = _start + 20;
        return address(bytes20(_metadata[_start:_end]));
    }

    /**
     * @notice Returns the validator set encoded as bytes. Verified against the
     * commitment stored in the module.
     * @dev Validator addresses are encoded as tightly packed array of bytes32,
     * sorted to match the enumerable set stored by the module.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The validator set encoded as bytes.
     */
    function validators(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        return _metadata[_validatorsOffset(_metadata):];
    }

    /**
     * @notice Returns the size of the validator set encoded in the metadata
     * @dev Validator addresses are encoded as tightly packed array of bytes32,
     * sorted to match the enumerable set stored by the module.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The size of the validator set encoded in the metadata
     */
    function validatorCount(bytes calldata _metadata)
        internal
        pure
        returns (uint256)
    {
        return (_metadata.length - _validatorsOffset(_metadata)) / 32;
    }

    /**
     * @notice Returns the offset in bytes of the list of validators within
     * `_metadata`.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The index at which the list of validators starts
     */
    function _validatorsOffset(bytes calldata _metadata)
        private
        pure
        returns (uint256)
    {
        return
            SIGNATURES_OFFSET +
            (uint256(threshold(_metadata)) * SIGNATURE_LENGTH);
    }
}
