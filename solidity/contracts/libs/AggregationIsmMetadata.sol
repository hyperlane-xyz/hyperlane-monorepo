// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * Format of metadata:
 * [   0:   1] ISM set size
 * [   1:????] Addresses of the entire ISM set, left padded to bytes32
 * [????:????] Metadata start/end uint128 offsets, packed as uint256
 * [????:????] ISM metadata, packed encoding
 */
library AggregationIsmMetadata {
    uint256 private constant ISM_COUNT_OFFSET = 0;
    uint256 private constant ISM_ADDRESSES_OFFSET = 1;
    uint256 private constant ISM_ADDRESS_LENGTH = 32;

    /**
     * @notice Returns the ISM set size
     * @param _metadata Encoded Aggregation ISM metadata.
     * @return The ISM set size
     */
    function count(bytes calldata _metadata) internal pure returns (uint8) {
        return uint8(bytes1(_metadata[ISM_COUNT_OFFSET:ISM_ADDRESSES_OFFSET]));
    }

    /**
     * @notice Returns the ISM set addresses packed as left-padded bytes32s
     * @param _metadata Encoded Aggregation ISM metadata.
     * @return ISM set addresses packed as left-padded bytes32s
     */
    function ismAddresses(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _end = ISM_ADDRESSES_OFFSET +
            (uint256(count(_metadata)) * ISM_ADDRESS_LENGTH);
        return _metadata[ISM_ADDRESSES_OFFSET:_end];
    }

    /**
     * @notice Returns the ISM address at `_index`
     * @dev Callers must ensure `_index < count(_metadata)`
     * @param _metadata Encoded Aggregation ISM metadata.
     * @param _index The index of the ISM address to return
     * @return The ISM address at `_index`
     */
    function ismAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (IInterchainSecurityModule)
    {
        // ISM addresses are left padded to bytes32 in order to match
        // abi.encodePacked(address[]).
        uint256 _start = ISM_ADDRESSES_OFFSET + (uint256(_index) * 32) + 12;
        uint256 _end = _start + 20;
        return
            IInterchainSecurityModule(address(bytes20(_metadata[_start:_end])));
    }

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
        uint256 _offsetsStart = ISM_ADDRESSES_OFFSET +
            (uint256(count(_metadata)) * 32);
        uint256 _start = _offsetsStart + (uint256(_index) * 32);
        uint256 _mid = _start + 16;
        uint256 _end = _mid + 16;
        return (
            uint256(uint128(bytes16(_metadata[_start:_mid]))),
            uint256(uint128(bytes16(_metadata[_mid:_end])))
        );
    }
}
