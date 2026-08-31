// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title Web2Message Library
 * @notice Serializes and deserializes Web2 API requests and responses formatted for Hyperlane Mailbox messaging.
 */
library Web2Message {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    enum HttpMethod {
        GET,
        POST,
        PUT,
        DELETE,
        PATCH,
        HEAD
    }

    enum MessageType {
        REQUEST,
        RESPONSE
    }

    struct RequestParams {
        uint32 targetDomain;
        HttpMethod method;
        string url;
        string headers;
        bytes body;
        address callbackAddress;
        bytes callbackData;
    }

    struct Request {
        bytes32 requestId;
        bytes32 sender;
        HttpMethod method;
        string url;
        string headers;
        bytes body;
        bytes32 callbackAddress;
        bytes callbackData;
    }

    struct Response {
        bytes32 requestId;
        bytes32 callbackAddress;
        uint256 statusCode;
        string headers;
        bytes responseBody;
        bytes callbackData;
    }

    /**
     * @notice Formats and encodes an outgoing Web2 API request from RequestParams calldata.
     */
    function formatRequest(
        bytes32 _requestId,
        bytes32 _sender,
        RequestParams calldata _params
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                MessageType.REQUEST,
                _requestId,
                _sender,
                _params.method,
                _params.url,
                _params.headers,
                _params.body,
                _params.callbackAddress.addressToBytes32(),
                _params.callbackData
            );
    }

    /**
     * @notice Formats and encodes an outgoing Web2 API request from a struct.
     */
    function encodeRequest(
        Request memory req
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                MessageType.REQUEST,
                req.requestId,
                req.sender,
                req.method,
                req.url,
                req.headers,
                req.body,
                req.callbackAddress,
                req.callbackData
            );
    }

    /**
     * @notice Decodes an incoming Web2 API request.
     */
    function decodeRequest(
        bytes calldata data
    ) internal pure returns (Request memory req) {
        MessageType msgType;
        (
            msgType,
            req.requestId,
            req.sender,
            req.method,
            req.url,
            req.headers,
            req.body,
            req.callbackAddress,
            req.callbackData
        ) = abi.decode(
            data,
            (
                MessageType,
                bytes32,
                bytes32,
                HttpMethod,
                string,
                string,
                bytes,
                bytes32,
                bytes
            )
        );
        require(msgType == MessageType.REQUEST, "Web2Message: not a request");
        return req;
    }

    /**
     * @notice Formats and encodes a Web2 API response from memory parameters.
     */
    function formatResponse(
        bytes32 _requestId,
        bytes32 _callbackAddress,
        uint256 _statusCode,
        string memory _headers,
        bytes memory _responseBody,
        bytes memory _callbackData
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                MessageType.RESPONSE,
                _requestId,
                _callbackAddress,
                _statusCode,
                _headers,
                _responseBody,
                _callbackData
            );
    }

    /**
     * @notice Formats and encodes a Web2 API response from a struct.
     */
    function encodeResponse(
        Response memory resp
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                MessageType.RESPONSE,
                resp.requestId,
                resp.callbackAddress,
                resp.statusCode,
                resp.headers,
                resp.responseBody,
                resp.callbackData
            );
    }

    /**
     * @notice Decodes an incoming Web2 API response.
     */
    function decodeResponse(
        bytes calldata data
    ) internal pure returns (Response memory resp) {
        MessageType msgType;
        (
            msgType,
            resp.requestId,
            resp.callbackAddress,
            resp.statusCode,
            resp.headers,
            resp.responseBody,
            resp.callbackData
        ) = abi.decode(
            data,
            (MessageType, bytes32, bytes32, uint256, string, bytes, bytes)
        );
        require(msgType == MessageType.RESPONSE, "Web2Message: not a response");
        return resp;
    }

    /**
     * @notice Returns the message type of the raw message body.
     */
    function messageType(
        bytes calldata data
    ) internal pure returns (MessageType) {
        return abi.decode(data, (MessageType));
    }
}
