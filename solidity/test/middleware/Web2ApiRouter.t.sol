// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {Web2ApiRouter} from "../../contracts/middleware/Web2ApiRouter.sol";
import {Web2Message} from "../../contracts/middleware/libs/Web2Message.sol";
import {IWeb2ApiRouter} from "../../contracts/interfaces/middleware/IWeb2ApiRouter.sol";
import {TestWeb2Receiver} from "../../contracts/test/TestWeb2Receiver.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract Web2ApiRouterTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    event ApiRequestDispatched(
        bytes32 indexed requestId,
        uint32 indexed web2Domain,
        bytes32 indexed endpointHash,
        address sender,
        string url,
        Web2Message.HttpMethod method
    );

    event ApiResponseReceived(
        bytes32 indexed requestId,
        uint32 indexed originDomain,
        bytes32 indexed endpointHash,
        uint256 statusCode,
        address recipient
    );

    MockHyperlaneEnvironment public environment;
    Web2ApiRouter public router;
    TestWeb2Receiver public receiver;

    uint32 public originDomain = 123;
    uint32 public web2Domain = 999;
    uint32 public otherDomain = 456;

    string public targetUrl = "https://api.coingecko.com/api/v3/simple/price";
    bytes32 public endpointHash;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(originDomain, web2Domain);

        address originMailbox = address(environment.mailboxes(originDomain));
        router = new Web2ApiRouter(originMailbox, web2Domain);
        receiver = new TestWeb2Receiver();

        endpointHash = keccak256(bytes(targetUrl));
    }

    function test_InitialState() public view {
        assertEq(router.web2Domain(), web2Domain);
    }

    function test_RequestApiDispatched() public {
        Web2Message.RequestParams memory params = Web2Message.RequestParams({
            targetDomain: web2Domain,
            method: Web2Message.HttpMethod.GET,
            url: targetUrl,
            headers: '{"accept":"application/json"}',
            body: "",
            callbackAddress: address(receiver),
            callbackData: "context-1"
        });

        vm.expectEmit(false, true, true, false, address(router));
        emit ApiRequestDispatched(
            bytes32(0),
            web2Domain,
            endpointHash,
            address(this),
            targetUrl,
            Web2Message.HttpMethod.GET
        );

        (bytes32 reqId, bytes32 msgId) = router.requestApi(params);
        assertTrue(reqId != bytes32(0));
        assertTrue(msgId != bytes32(0));
    }

    function test_QuoteApiRequest() public view {
        Web2Message.RequestParams memory params = Web2Message.RequestParams({
            targetDomain: web2Domain,
            method: Web2Message.HttpMethod.POST,
            url: targetUrl,
            headers: '{"content-type":"application/json"}',
            body: '{"query":"hyperlane"}',
            callbackAddress: address(receiver),
            callbackData: "quote-test"
        });

        uint256 fee = router.quoteApiRequest(params);
        // Default MockMailbox quote is 0
        assertEq(fee, 0);
    }

    function test_HandleWeb2Response() public {
        bytes32 reqId = keccak256("req-123");
        bytes memory responsePayload = abi.encode("eth_price: 3500");
        bytes memory callbackData = "cb-data";

        bytes memory responseBody = Web2Message.formatResponse(
            reqId,
            address(receiver).addressToBytes32(),
            200,
            '{"content-type":"application/json"}',
            responsePayload,
            callbackData
        );

        address originMailbox = address(environment.mailboxes(originDomain));

        vm.expectEmit(true, true, true, true, address(router));
        emit ApiResponseReceived(
            reqId,
            web2Domain,
            endpointHash,
            200,
            address(receiver)
        );

        vm.prank(originMailbox);
        router.handle(web2Domain, endpointHash, responseBody);

        assertEq(receiver.lastRequestId(), reqId);
        assertEq(receiver.lastOrigin(), web2Domain);
        assertEq(receiver.lastEndpointHash(), endpointHash);
        assertEq(receiver.lastStatusCode(), 200);
        assertEq(receiver.lastResponseBody(), responsePayload);
        assertEq(receiver.lastCallbackData(), callbackData);
        assertEq(receiver.responseCount(), 1);
    }

    function test_EndToEndRequestAndResponse() public {
        // Step 1: Receiver dispatches request
        (bytes32 reqId, ) = receiver.dispatchViaRouter(
            address(router),
            web2Domain,
            Web2Message.HttpMethod.GET,
            targetUrl,
            '{"accept":"application/json"}',
            "",
            "ctx-e2e"
        );

        assertTrue(reqId != bytes32(0));

        // Step 2: Simulate response delivery from web2Domain
        bytes memory respData = abi.encode("result_ok");
        bytes memory responseBody = Web2Message.formatResponse(
            reqId,
            address(receiver).addressToBytes32(),
            200,
            "{}",
            respData,
            "ctx-e2e"
        );

        address originMailbox = address(environment.mailboxes(originDomain));

        vm.prank(originMailbox);
        router.handle(web2Domain, endpointHash, responseBody);

        assertEq(receiver.lastRequestId(), reqId);
        assertEq(receiver.lastStatusCode(), 200);
        assertEq(receiver.lastResponseBody(), respData);
        assertEq(receiver.lastCallbackData(), "ctx-e2e");
    }

    function test_HandleRevertsIfCallbackReverts() public {
        receiver.setShouldRevert(true);

        bytes32 reqId = keccak256("req-fail");
        bytes memory responseBody = Web2Message.formatResponse(
            reqId,
            address(receiver).addressToBytes32(),
            500,
            "{}",
            "error",
            ""
        );

        address originMailbox = address(environment.mailboxes(originDomain));

        vm.prank(originMailbox);
        vm.expectRevert("TestWeb2Receiver: intentional revert");
        router.handle(web2Domain, endpointHash, responseBody);
    }

    function test_HandleEnrolledRemoteRouter() public {
        address originMailbox = address(environment.mailboxes(originDomain));
        bytes32 remoteRouterAddr = address(0xAAAA).addressToBytes32();

        // Enroll remote router for otherDomain
        router.enrollRemoteRouter(otherDomain, remoteRouterAddr);

        // Disallowed sender from otherDomain reverts
        vm.prank(originMailbox);
        vm.expectRevert("Enrolled router does not match sender");
        router.handle(
            otherDomain,
            address(0xBBBB).addressToBytes32(),
            Web2Message.formatResponse(
                bytes32(0),
                address(0).addressToBytes32(),
                200,
                "",
                "",
                ""
            )
        );

        // Matching remote router sender succeeds
        vm.prank(originMailbox);
        router.handle(
            otherDomain,
            remoteRouterAddr,
            Web2Message.formatResponse(
                bytes32(0),
                address(0).addressToBytes32(),
                200,
                "",
                "",
                ""
            )
        );
    }

    function test_SetWeb2DomainOnlyOwner() public {
        router.setWeb2Domain(888);
        assertEq(router.web2Domain(), 888);

        address nonOwner = address(0xBEEF);
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        router.setWeb2Domain(777);
    }
}
