// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IWeb2Receiver} from "../interfaces/middleware/IWeb2Receiver.sol";
import {IWeb2ApiRouter} from "../interfaces/middleware/IWeb2ApiRouter.sol";
import {Web2Message} from "../middleware/libs/Web2Message.sol";

contract TestWeb2Receiver is IWeb2Receiver {
    bytes32 public lastRequestId;
    uint32 public lastOrigin;
    bytes32 public lastEndpointHash;
    uint256 public lastStatusCode;
    bytes public lastResponseBody;
    bytes public lastCallbackData;
    uint256 public responseCount;

    bool public shouldRevert;

    event TestResponseHandled(
        bytes32 indexed requestId,
        uint32 origin,
        bytes32 endpointHash,
        uint256 statusCode,
        bytes responseBody,
        bytes callbackData
    );

    function setShouldRevert(bool _revert) external {
        shouldRevert = _revert;
    }

    function dispatchViaRouter(
        address _router,
        uint32 _web2Domain,
        Web2Message.HttpMethod _method,
        string calldata _url,
        string calldata _headers,
        bytes calldata _body,
        bytes calldata _callbackData
    ) external payable returns (bytes32 requestId, bytes32 messageId) {
        Web2Message.RequestParams memory params = Web2Message.RequestParams({
            targetDomain: _web2Domain,
            method: _method,
            url: _url,
            headers: _headers,
            body: _body,
            callbackAddress: address(this),
            callbackData: _callbackData
        });
        return IWeb2ApiRouter(_router).requestApi{value: msg.value}(params);
    }

    function handleWeb2Response(
        bytes32 requestId,
        uint32 origin,
        bytes32 endpointHash,
        uint256 statusCode,
        bytes calldata responseBody,
        bytes calldata callbackData
    ) external payable override {
        require(!shouldRevert, "TestWeb2Receiver: intentional revert");

        lastRequestId = requestId;
        lastOrigin = origin;
        lastEndpointHash = endpointHash;
        lastStatusCode = statusCode;
        lastResponseBody = responseBody;
        lastCallbackData = callbackData;
        responseCount++;

        emit TestResponseHandled(
            requestId,
            origin,
            endpointHash,
            statusCode,
            responseBody,
            callbackData
        );
    }
}
