// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 * [????:????] Metadata start/end uint32 offsets, packed as uint64
 * [????:????] ISM metadata, packed encoding
 */
library AggregationIsmMetadata {
    uint256 private constant OFFSET_SIZE = 4;

    /**
     * @notice Returns whether or not metadata was provided for the ISM at
     * `_index`
     * @dev Callers must ensure `_index < count(_metadata)`
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to check for metadata for
     * @return Whether or not metadata was provided for the ISM at `_index`
     */
    function hasMetadata(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bool)
    {
        (uint256 _start, ) = _metadataOffsets(_metadata, _index);
        return _start > 0;
    }

    /**
     * @notice Returns the metadata provided for the ISM at `_index`
     * @dev Callers must ensure `_index < count(_metadata)`
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
        (uint256 _start, uint256 _end) = _metadataOffsets(_metadata, _index);
        return _metadata[_start:_end];
    }

    /**
     * @notice Returns the offsets of the metadata provided for the ISM at
     * `_index`, or zeroes if not provided
     * @dev Callers must ensure `_index < count(_metadata)`
     * @param _metadata Encoded Aggregation ISM metadata
     * @param _index The index of the ISM to return metadata offsets for
     * @return The offsets of the metadata provided for the ISM at `_index`, or
     * zeroes if not provided
     */
    function _metadataOffsets(bytes calldata _metadata, uint8 _index)
        private
        pure
        returns (uint256, uint256)
    {
        uint256 _start = (uint256(_index) * OFFSET_SIZE * 2);
        uint256 _mid = _start + OFFSET_SIZE;
        uint256 _end = _mid + OFFSET_SIZE;
        return (
            uint256(uint32(bytes4(_metadata[_start:_mid]))),
            uint256(uint32(bytes4(_metadata[_mid:_end])))
        );
    }
}
