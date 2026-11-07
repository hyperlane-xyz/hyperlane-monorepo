// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title BlockHashIsmMetadata
 * @notice Library for parsing BlockHashIsm metadata
 *
 * Format of metadata:
 * [   0:   8] Block number (uint64)
 * [   8:  10] Block header length (uint16)
 * [  10:  10+headerLen] RLP encoded block header
 * [  ...:  ...+2] Transaction index in block (uint16)
 * [  ...:  ...+1] Log index in receipt (uint8)
 * [  ...:  end] MPT proof nodes (concatenated, each prefixed with uint16 length)
 */
library BlockHashIsmMetadata {
    uint256 private constant BLOCK_NUMBER_OFFSET = 0;
    uint256 private constant HEADER_LENGTH_OFFSET = 8;
    uint256 private constant HEADER_OFFSET = 10;

    /**
     * @notice Returns the block number
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return Block number
     */
    function blockNumber(
        bytes calldata _metadata
    ) internal pure returns (uint64) {
        return uint64(bytes8(_metadata[BLOCK_NUMBER_OFFSET:HEADER_LENGTH_OFFSET]));
    }

    /**
     * @notice Returns the block header length
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return Header length in bytes
     */
    function headerLength(
        bytes calldata _metadata
    ) internal pure returns (uint16) {
        return uint16(bytes2(_metadata[HEADER_LENGTH_OFFSET:HEADER_OFFSET]));
    }

    /**
     * @notice Returns the RLP encoded block header
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return The block header bytes
     */
    function blockHeader(
        bytes calldata _metadata
    ) internal pure returns (bytes calldata) {
        uint16 len = headerLength(_metadata);
        return _metadata[HEADER_OFFSET:HEADER_OFFSET + len];
    }

    /**
     * @notice Returns the transaction index
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return Transaction index in the block
     */
    function txIndex(
        bytes calldata _metadata
    ) internal pure returns (uint16) {
        uint256 offset = HEADER_OFFSET + headerLength(_metadata);
        return uint16(bytes2(_metadata[offset:offset + 2]));
    }

    /**
     * @notice Returns the log index within the receipt
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return Log index
     */
    function logIndex(
        bytes calldata _metadata
    ) internal pure returns (uint8) {
        uint256 offset = HEADER_OFFSET + headerLength(_metadata) + 2;
        return uint8(_metadata[offset]);
    }

    /**
     * @notice Returns the MPT proof nodes
     * @param _metadata ABI encoded BlockHashIsm metadata
     * @return proof Array of proof nodes
     */
    function proofNodes(
        bytes calldata _metadata
    ) internal pure returns (bytes[] memory proof) {
        uint256 offset = HEADER_OFFSET + headerLength(_metadata) + 3;
        bytes calldata proofData = _metadata[offset:];

        // First pass: count nodes
        uint256 count = 0;
        uint256 pos = 0;
        while (pos < proofData.length) {
            uint16 nodeLen = uint16(bytes2(proofData[pos:pos + 2]));
            pos += 2 + nodeLen;
            count++;
        }

        // Second pass: extract nodes
        proof = new bytes[](count);
        pos = 0;
        for (uint256 i = 0; i < count; i++) {
            uint16 nodeLen = uint16(bytes2(proofData[pos:pos + 2]));
            proof[i] = proofData[pos + 2:pos + 2 + nodeLen];
            pos += 2 + nodeLen;
        }
    }

    /**
     * @notice Encodes the transaction index as RLP for MPT key
     * @param _txIndex The transaction index
     * @return RLP encoded key
     */
    function encodeTxIndexAsKey(
        uint16 _txIndex
    ) internal pure returns (bytes memory) {
        if (_txIndex == 0) {
            return hex"80"; // RLP encoding of empty string (0)
        } else if (_txIndex < 128) {
            return abi.encodePacked(uint8(_txIndex));
        } else if (_txIndex < 256) {
            return abi.encodePacked(uint8(0x81), uint8(_txIndex));
        } else {
            return abi.encodePacked(uint8(0x82), uint16(_txIndex));
        }
    }
}
