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
library AggregationIsmMetadata {
    uint256 private constant ISM_COUNT_OFFSET = 0;
    uint256 private constant ISM_ADDRESS_OFFSET = 1;
    uint256 private constant ISM_ADDRESS_LENGTH = 32;

    /**
     * @notice Returns the merkle root of the signed checkpoint.
     * @param _metadata ABI encoded Aggregation ISM metadata.
     * @return Merkle root of the signed checkpoint
     */
    function count(bytes calldata _metadata) internal pure returns (uint8) {
        return uint8(bytes1(_metadata[ISM_COUNT_OFFSET:ISM_ADDRESS_OFFSET]));
    }

    /**
     * @notice Returns the index of the signed checkpoint.
     * @param _metadata ABI encoded Aggregation ISM metadata.
     * @return Index of the signed checkpoint
     */
    function ismAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bytes32)
    {
        uint256 _start = ISM_ADDRESS_OFFSET + _index * ISM_ADDRESS_LENGTH;
        bytes32 _ism = bytes32(_metadata[_start:_start + ISM_ADDRESS_LENGTH]);
        return _ism;
    }

    function _metadataOffsetAndLength(bytes calldata _metadata, uint8 _index)
        private
        pure
        returns (uint128, uint128)
    {
        uint8 _count = count(_metadata);
        uint256 _start = ISM_ADDRESS_OFFSET +
            (_count + _index) *
            ISM_ADDRESS_LENGTH;
        uint128 _offset = uint128(bytes16(_metadata[_start:_start + 16]));
        uint128 _length = uint128(bytes16(_metadata[_start + 16:_start + 32]));
        return (_offset, _length);
    }

    /**
     * @notice Returns the origin mailbox of the signed checkpoint as bytes32.
     * @param _metadata ABI encoded Aggregation ISM metadata.
     * @return Origin mailbox of the signed checkpoint as bytes32
     */
    function metadataAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bytes calldata)
    {
        uint8 _count = count(_metadata);
        // TODO: start/end more efficient
        (uint128 _offset, uint128 _length) = _metadataOffsetAndLength(
            _metadata,
            _index
        );
        return _metadata[_offset:_offset + _length];
    }
}
