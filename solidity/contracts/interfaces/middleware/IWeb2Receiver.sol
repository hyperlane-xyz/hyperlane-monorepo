// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IWeb2Receiver {
    /**
     * @notice Handles an incoming Web2 API response delivered from Hyperlane.
     * @param requestId The unique identifier for the originating request.
     * @param origin The domain ID of the Web2 domain.
     * @param endpointHash The bytes32 hash of the API URL (keccak256(bytes(url))).
     * @param statusCode The HTTP status code returned by the API (e.g. 200, 404, 500).
     * @param responseBody The raw byte payload returned in the HTTP response.
     * @param callbackData Contextual data passed by the requester when dispatching.
     */
    function handleWeb2Response(
        bytes32 requestId,
        uint32 origin,
        bytes32 endpointHash,
        uint256 statusCode,
        bytes calldata responseBody,
        bytes calldata callbackData
    ) external payable;
}
