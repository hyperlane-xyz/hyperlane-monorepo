// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [0:8] Metadata start/end uint32 ranges for preVerifyISM
 * and Watcher signatures, packed as uint64
 * [????:????] preVerifyISM metadata, packed encoding
 * [????:????] Watcher signatures, 65 bytes each, length == Threshold
 */
library OptimisticIsmMetadata {
    uint256 private constant RANGE_SIZE = 4;
    uint256 private constant SIGNATURE_LENGTH = 65;

    /**
     * @notice Returns the watcher ECDSA signature at `_index`
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
        // Signature start index is always specified in the 2nd metadata range
        (uint256 _signaturesStart, ) = _metadataRange(_metadata, 1);
        uint256 _start = _signaturesStart + (_index * SIGNATURE_LENGTH);
        uint256 _end = _start + SIGNATURE_LENGTH;
        return _metadata[_start:_end];
    }

    /**
     * @notice Returns the range of the metadata provided for the ISM at
     * `_index`
     * @dev Callers must ensure _index is less than the number of metadatas
     * provided
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to return metadata range for
     * @return The range of the metadata provided for the ISM at `_index`, or
     */
    function _metadataRange(bytes calldata _metadata, uint8 _index)
        private
        pure
        returns (uint32, uint32)
    {
        uint256 _start = (uint32(_index) * RANGE_SIZE * 2);
        uint256 _mid = _start + RANGE_SIZE;
        uint256 _end = _mid + RANGE_SIZE;
        return (
            uint32(bytes4(_metadata[_start:_mid])),
            uint32(bytes4(_metadata[_mid:_end]))
        );
    }

    /**
     * @notice Returns the metadata provided for the ISM at index 0
     * @param _metadata Encoded Aggregation ISM metadata
     * @return The metadata provided for the ISM at _index 0
     */
    function metadataAt(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        (uint32 _start, uint32 _end) = _metadataRange(_metadata, 0);
        return _metadata[_start:_end];
    }
}
