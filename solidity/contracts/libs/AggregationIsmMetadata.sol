// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * Format of metadata:
 * [   0:   1] ISM set size
 * [   1:????] Addresses of the entire ISM set, left padded to bytes32
 * [????:????] Metadata offsets (i.e. for each ISM, where does the metadata for this ISM start? Zero if not provided)
 * [????:????] ISM metadata, packed encoding
 */
library AggregationIsmMetadata {
    uint256 private constant ISM_COUNT_OFFSET = 0;
    uint256 private constant ISM_ADDRESSES_OFFSET = 1;
    uint256 private constant ISM_ADDRESS_LENGTH = 32;
    uint256 private constant METADATA_OFFSET_LENGTH = 32;

    function count(bytes calldata _metadata) internal pure returns (uint8) {
        return uint8(bytes1(_metadata[ISM_COUNT_OFFSET:ISM_ADDRESSES_OFFSET]));
    }

    function ismAddresses(bytes calldata _metadata)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _end = ISM_ADDRESSES_OFFSET +
            count(_metadata) *
            ISM_ADDRESS_LENGTH;
        return _metadata[ISM_ADDRESSES_OFFSET:_end];
    }

    function ismAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (IInterchainSecurityModule)
    {
        // ISM addresses are left padded to bytes32 in order to match
        // abi.encodePacked(address[]).
        uint256 _start = ISM_ADDRESSES_OFFSET + (_index * 32) + 12;
        uint256 _end = _start + 20;
        return
            IInterchainSecurityModule(address(bytes20(_metadata[_start:_end])));
    }

    function hasMetadata(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bool)
    {
        return _metadataOffset(_metadata, _index) == 0;
    }

    function metadataAt(bytes calldata _metadata, uint8 _index)
        internal
        pure
        returns (bytes calldata)
    {
        uint256 _start = _metadataOffset(_metadata, _index);
        if (_index == count(_metadata) - 1) {
            return _metadata[_start:];
        } else {
            uint256 _end = _metadataOffset(_metadata, _index + 1);
            return _metadata[_start:_end];
        }
    }

    function _metadataOffset(bytes calldata _metadata, uint8 _index)
        private
        pure
        returns (uint256)
    {
        uint256 _offsetsStart = ISM_ADDRESSES_OFFSET + count(_metadata) * 32;
        uint256 _start = _offsetsStart + (_index * 32);
        uint256 _end = _start + 32;
        return uint256(bytes32(_metadata[_start:_end]));
    }
}
