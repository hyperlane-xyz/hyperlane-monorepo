// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Web2Message} from "../../middleware/libs/Web2Message.sol";

interface IWeb2ApiRouter {
    /**
     * @notice Emitted when a new Web2 API request is dispatched to the Web2 domain.
     * @param requestId Unique identifier for the request.
     * @param web2Domain The domain ID corresponding to Web2.
     * @param endpointHash The hash of the URL (keccak256(bytes(url))).
     * @param sender The address initiating the API request.
     * @param url The target Web2 endpoint URL.
     * @param method The HTTP method (GET, POST, etc.).
     */
    event ApiRequestDispatched(
        bytes32 indexed requestId,
        uint32 indexed web2Domain,
        bytes32 indexed endpointHash,
        address sender,
        string url,
        Web2Message.HttpMethod method
    );

    /**
     * @notice Emitted when a Web2 API response is received from the Web2 domain.
     * @param requestId Unique identifier for the request.
     * @param originDomain The origin domain (Web2 domain).
     * @param endpointHash The hash of the URL.
     * @param statusCode The HTTP status code returned.
     * @param recipient The callback recipient contract.
     */
    event ApiResponseReceived(
        bytes32 indexed requestId,
        uint32 indexed originDomain,
        bytes32 indexed endpointHash,
        uint256 statusCode,
        address recipient
    );

    /**
     * @notice Returns the designated Web2 domain ID.
     */
    function web2Domain() external view returns (uint32);

    /**
     * @notice Dispatches an API request using structured RequestParams.
     * @param _params Parameters defining target domain, method, url, headers, body, callback, and callback data.
     * @return requestId The unique ID assigned to this request.
     * @return messageId The Hyperlane message ID returned by Mailbox.dispatch.
     */
    function requestApi(
        Web2Message.RequestParams calldata _params
    ) external payable returns (bytes32 requestId, bytes32 messageId);

    /**
     * @notice Quotes the fee required to dispatch a Web2 API request.
     * @param _params Request parameters.
     * @return fee The estimated gas payment / dispatch fee.
     */
    function quoteApiRequest(
        Web2Message.RequestParams calldata _params
    ) external view returns (uint256 fee);
}
