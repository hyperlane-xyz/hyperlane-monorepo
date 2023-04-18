// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [   0:  ???] Watcher signatures, 65 bytes each, length == Threshold
 */
library OptimisticIsmMetadata {
    uint256 private constant SIGNATURES_OFFSET = 0;
    uint256 private constant SIGNATURE_LENGTH = 65;

    /**
     * @notice Returns the watcher ECDSA signature at `_index`.
     * @dev Assumes signatures are sorted by watcher
     * @dev Assumes `_metadata` encodes `threshold` signatures.
     * @dev Assumes `_index` is less than `threshold`
     * @param _metadata ABI encoded Optimisitc ISM metadata.
     * @param _index The index of the signature to return.
     * @return The watcher ECDSA signature at `_index`.
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
