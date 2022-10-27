// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  32] Merkle root
 * [  32:  64] Root index
 * [  64:  96] Origin mailbox address
 * [  96:1120] Merkle proof
 * [1120:1152] Threshold
 * [1152:????] Validator signatures
 * [????:????] Validator addresses
 */
library MultisigModuleMetadata {
    /**
     * @notice Returns the merkle root of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Merkle root of the signed checkpoint
     */
    function root(bytes calldata _metadata) internal pure returns (bytes32) {
        return bytes32(_metadata[0:32]);
    }

    /**
     * @notice Returns the index of the signed checkpoint.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return Index of the signed checkpoint
     */
    function index(bytes calldata _metadata) internal pure returns (uint256) {
        return uint256(bytes32(_metadata[32:64]));
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
        return bytes32(_metadata[64:96]);
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
        return abi.decode(_metadata[96:1120], (bytes32[32]));
    }

    /**
     * @notice Returns the number of required signatures. Verified against
     * the commitment stored in the module.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The number of required signatures.
     */
    function threshold(bytes calldata _metadata)
        internal
        pure
        returns (uint256)
    {
        return uint256(bytes32(_metadata[1120:1152]));
    }

    /**
     * @notice Returns the validator ECDSA signature at `_index`.
     * @dev Assumes signatures are sorted by ascending validator address.
     * @dev Assumes `_metadata` encodes `threshold` signatures.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @param _index The index of the signature to return.
     * @return The validator ECDSA signature at `_index`.
     */
    function signatureAt(bytes calldata _metadata, uint256 _index)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = 1152 + (_index * 65);
        uint256 _end = _start + 65;
        return _metadata[_start:_end];
    }

    /**
     * @notice Returns the validator address at `_index`.
     * @dev Assumes validators are sorted by ascending validator address.
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
        uint256 _start = 1152 +
            (threshold(_metadata)) *
            65 +
            (_index * 32) +
            12;
        uint256 _end = _start + 20;
        return address(bytes20(_metadata[_start:_end]));
    }

    /**
     * @notice Returns the validator set encoded as bytes. Verified against the
     * commitment stored in the module.
     * @dev Validator addresses are encoded as tightly packed array of bytes32,
     * sorted in ascending order.
     * @param _metadata ABI encoded Multisig ISM metadata.
     * @return The validator set encoded as bytes.
     */
    function validators(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = 1152 + (threshold(_metadata)) * 65;
        uint256 _end = _metadata.length;
        return _metadata[_start:_end];
    }
}
