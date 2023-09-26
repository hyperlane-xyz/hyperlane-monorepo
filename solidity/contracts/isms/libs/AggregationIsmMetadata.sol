// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 *
 * [????:????] Metadata start/end uint32 ranges, packed as uint64
 * [????:????] ISM metadata, packed encoding
 */
library AggregationIsmMetadata {
    uint256 private constant RANGE_SIZE = 4;

    /**
     * @notice Returns whether or not metadata was provided for the ISM at
     * `_index`
     * @dev Callers must ensure _index is less than the number of metadatas
     * provided
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to check for metadata for
     * @return Whether or not metadata was provided for the ISM at `_index`
     */
    function hasMetadata(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bool)
    {
        (uint32 _start, ) = _metadataRange(_metadata, _index);
        return _start > 0;
    }

    /**
     * @notice Returns the metadata provided for the ISM at `_index`
     * @dev Callers must ensure _index is less than the number of metadatas
     * provided
     * @dev Callers must ensure `hasMetadata(_metadata, _index)`
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to return metadata for
     * @return The metadata provided for the ISM at `_index`
     */
    function metadataAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bytes calldata)
    {
        (uint32 _start, uint32 _end) = _metadataRange(_metadata, _index);
        return _metadata[_start:_end];
    }

    /**
     * @notice Returns the range of the metadata provided for the ISM at
     * `_index`, or zeroes if not provided
     * @dev Callers must ensure _index is less than the number of metadatas
     * provided
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to return metadata range for
     * @return The range of the metadata provided for the ISM at `_index`, or
     * zeroes if not provided
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
}
