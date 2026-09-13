// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title RLPReader
 * @notice Minimal RLP decoding library for block headers and receipts
 * @dev Based on https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/
 */
library RLPReader {
    /**
     * @notice Decodes an RLP item and returns offset and length
     * @param _data The RLP encoded data
     * @param _offset Starting offset in data
     * @return dataOffset Offset where actual data starts
     * @return dataLen Length of the data
     * @return consumed Total bytes consumed (header + data)
     */
    function decodeItemOffset(
        bytes memory _data,
        uint256 _offset
    ) internal pure returns (uint256 dataOffset, uint256 dataLen, uint256 consumed) {
        require(_offset < _data.length, "RLP: offset OOB");

        uint8 prefix = uint8(_data[_offset]);

        if (prefix <= 0x7f) {
            return (_offset, 1, 1);
        } else if (prefix <= 0xb7) {
            uint256 strLen = prefix - 0x80;
            return (_offset + 1, strLen, 1 + strLen);
        } else if (prefix <= 0xbf) {
            uint256 lenBytes = prefix - 0xb7;
            uint256 strLen = _decodeLength(_data, _offset + 1, lenBytes);
            return (_offset + 1 + lenBytes, strLen, 1 + lenBytes + strLen);
        } else if (prefix <= 0xf7) {
            uint256 listLen = prefix - 0xc0;
            return (_offset + 1, listLen, 1 + listLen);
        } else {
            uint256 lenBytes = prefix - 0xf7;
            uint256 listLen = _decodeLength(_data, _offset + 1, lenBytes);
            return (_offset + 1 + lenBytes, listLen, 1 + lenBytes + listLen);
        }
    }

    /**
     * @notice Decodes a list and returns array of items
     * @param _data RLP encoded list
     * @return items Array of RLP items as bytes
     */
    function decodeList(
        bytes memory _data
    ) internal pure returns (bytes[] memory items) {
        return decodeListAt(_data, 0);
    }

    /**
     * @notice Decodes a list starting at offset
     * @param _data RLP encoded data
     * @param _offset Starting offset
     * @return items Array of RLP items as bytes
     */
    function decodeListAt(
        bytes memory _data,
        uint256 _offset
    ) internal pure returns (bytes[] memory items) {
        (uint256 listDataOffset, uint256 listDataLen, ) = decodeItemOffset(_data, _offset);

        // First pass: count items
        uint256 count = 0;
        uint256 pos = listDataOffset;
        uint256 listEnd = listDataOffset + listDataLen;

        while (pos < listEnd) {
            (, , uint256 consumed) = decodeItemOffset(_data, pos);
            pos += consumed;
            count++;
        }

        // Second pass: extract items
        items = new bytes[](count);
        pos = listDataOffset;

        for (uint256 i = 0; i < count; i++) {
            (, , uint256 consumed) = decodeItemOffset(_data, pos);
            items[i] = _slice(_data, pos, consumed);
            pos += consumed;
        }
    }

    /**
     * @notice Extracts the receiptsRoot from an RLP encoded block header
     * @dev receiptsRoot is at index 5 in the header list
     * @param _header RLP encoded block header
     * @return receiptsRoot The receipts root hash
     */
    function extractReceiptsRoot(
        bytes calldata _header
    ) internal pure returns (bytes32 receiptsRoot) {
        bytes memory headerMem = _header;
        bytes[] memory items = decodeList(headerMem);
        require(items.length >= 6, "RLP: invalid header length");

        bytes memory rootItem = items[5];
        bytes memory rootData = toBytes(rootItem);
        require(rootData.length == 32, "RLP: invalid receiptsRoot length");

        assembly {
            receiptsRoot := mload(add(rootData, 32))
        }
    }

    /**
     * @notice Decodes raw bytes from an RLP item
     * @param _item RLP encoded item
     * @return The decoded bytes
     */
    function toBytes(
        bytes memory _item
    ) internal pure returns (bytes memory) {
        if (_item.length == 0) return "";

        uint8 prefix = uint8(_item[0]);

        if (prefix <= 0x7f) {
            bytes memory result = new bytes(1);
            result[0] = _item[0];
            return result;
        } else if (prefix <= 0xb7) {
            uint256 strLen = prefix - 0x80;
            return _slice(_item, 1, strLen);
        } else if (prefix <= 0xbf) {
            uint256 lenBytes = prefix - 0xb7;
            uint256 strLen = _decodeLength(_item, 1, lenBytes);
            return _slice(_item, 1 + lenBytes, strLen);
        }

        revert("RLP: not a string");
    }

    /**
     * @notice Decodes an address from an RLP item
     * @param _item RLP encoded item
     * @return The decoded address
     */
    function toAddress(bytes memory _item) internal pure returns (address) {
        bytes memory data = toBytes(_item);
        require(data.length == 20, "RLP: invalid address length");

        address result;
        assembly {
            result := mload(add(data, 20))
        }
        return result;
    }

    /**
     * @notice Decodes length from big-endian bytes at offset
     */
    function _decodeLength(
        bytes memory _data,
        uint256 _offset,
        uint256 _lenBytes
    ) private pure returns (uint256 length) {
        require(_offset + _lenBytes <= _data.length, "RLP: length OOB");
        for (uint256 i = 0; i < _lenBytes; i++) {
            length = (length << 8) | uint8(_data[_offset + i]);
        }
    }

    /**
     * @notice Slices bytes from memory
     */
    function _slice(
        bytes memory _data,
        uint256 _start,
        uint256 _length
    ) private pure returns (bytes memory result) {
        require(_start + _length <= _data.length, "RLP: slice OOB");
        result = new bytes(_length);
        for (uint256 i = 0; i < _length; i++) {
            result[i] = _data[_start + i];
        }
    }
}
