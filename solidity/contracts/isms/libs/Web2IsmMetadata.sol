// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title Web2IsmMetadata
 * @notice Parsing and formatting library for Web2 Interchain Security Module metadata.
 *
 * Format of metadata:
 * [   0:  32] Endpoint hash (keccak256(bytes(url)))
 * [  32:  40] Timestamp (uint64)
 * [  40:  72] Request ID (bytes32)
 * [  72:????] Keeper signatures (length := threshold * 65)
 */
library Web2IsmMetadata {
    uint8 private constant ENDPOINT_HASH_OFFSET = 0;
    uint8 private constant TIMESTAMP_OFFSET = 32;
    uint8 private constant REQUEST_ID_OFFSET = 40;
    uint8 private constant SIGNATURES_OFFSET = 72;
    uint8 private constant SIGNATURE_LENGTH = 65;

    /**
     * @notice Returns the endpoint hash encoded in metadata.
     * @param _metadata Encoded Web2 ISM metadata.
     * @return bytes32 hash of the API URL.
     */
    function endpointHash(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        return
            bytes32(_metadata[ENDPOINT_HASH_OFFSET:ENDPOINT_HASH_OFFSET + 32]);
    }

    /**
     * @notice Returns the timestamp when the keeper executed the request.
     * @param _metadata Encoded Web2 ISM metadata.
     * @return uint64 timestamp.
     */
    function timestamp(
        bytes calldata _metadata
    ) internal pure returns (uint64) {
        return uint64(bytes8(_metadata[TIMESTAMP_OFFSET:TIMESTAMP_OFFSET + 8]));
    }

    /**
     * @notice Returns the request ID associated with the Web2 call.
     * @param _metadata Encoded Web2 ISM metadata.
     * @return bytes32 request ID.
     */
    function requestId(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        return bytes32(_metadata[REQUEST_ID_OFFSET:REQUEST_ID_OFFSET + 32]);
    }

    /**
     * @notice Returns the keeper ECDSA signature at `_index`.
     * @param _metadata Encoded Web2 ISM metadata.
     * @param _index The index of the signature.
     * @return The 65-byte signature.
     */
    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure returns (bytes calldata) {
        uint256 start = SIGNATURES_OFFSET + (_index * SIGNATURE_LENGTH);
        uint256 end = start + SIGNATURE_LENGTH;
        require(
            end <= _metadata.length,
            "Web2IsmMetadata: signature index out of bounds"
        );
        return _metadata[start:end];
    }

    /**
     * @notice Returns the total number of signatures in metadata.
     * @param _metadata Encoded Web2 ISM metadata.
     * @return count Number of 65-byte signatures.
     */
    function signatureCount(
        bytes calldata _metadata
    ) internal pure returns (uint256) {
        if (_metadata.length < SIGNATURES_OFFSET) {
            return 0;
        }
        uint256 sigBytes = _metadata.length - SIGNATURES_OFFSET;
        require(
            sigBytes % SIGNATURE_LENGTH == 0,
            "Web2IsmMetadata: invalid signatures length"
        );
        return sigBytes / SIGNATURE_LENGTH;
    }

    /**
     * @notice Formats metadata from individual fields.
     * @param _endpointHash The hash of the URL.
     * @param _timestamp The execution timestamp.
     * @param _requestId The request ID.
     * @param _signatures Concatenated 65-byte signatures.
     * @return Formatted metadata bytes.
     */
    function formatMetadata(
        bytes32 _endpointHash,
        uint64 _timestamp,
        bytes32 _requestId,
        bytes memory _signatures
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _endpointHash,
                _timestamp,
                _requestId,
                _signatures
            );
    }
}
