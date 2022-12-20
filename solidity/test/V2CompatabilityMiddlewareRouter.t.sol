// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/test/TestRecipient.sol";
import {V2CompatibilityRouter} from "../contracts/middleware/V2CompatibilityRouter.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract V2CompatibilityRouterTest is Test {
    MockHyperlaneEnvironment testEnvironment;

    V2CompatibilityRouter originRouter;
    V2CompatibilityRouter destinationRouter;

    TestRecipient recipient;

    uint32 originDomain = 123;
    uint32 destinationDomain = 321;

    uint32 v2OriginDomain = 456;
    uint32 v2DestinationDomain = 654;

    function setUp() public {
        originRouter = new V2CompatibilityRouter();
        destinationRouter = new V2CompatibilityRouter();

        testEnvironment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );

        originRouter.initialize(
            address(this),
            address(testEnvironment.connectionManager(originDomain)),
            address(0)
        );
        destinationRouter.initialize(
            address(this),
            address(testEnvironment.connectionManager(destinationDomain)),
            address(0)
        );

        uint32[] memory v1Domains = new uint32[](2);
        v1Domains[0] = originDomain;
        v1Domains[1] = destinationDomain;

        uint32[] memory v2Domains = new uint32[](2);
        v2Domains[0] = v2OriginDomain;
        v2Domains[1] = v2DestinationDomain;

        originRouter.mapDomains(v1Domains, v2Domains);
        destinationRouter.mapDomains(v1Domains, v2Domains);

        originRouter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationRouter))
        );
        destinationRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );

        recipient = new TestRecipient();
    }

    function testCanSendMessageWithV2Domains(bytes calldata _messageBody)
        public
    {
        originRouter.dispatch(
            v2DestinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            _messageBody
        );

        vm.expectCall(
            address(recipient),
            abi.encodeWithSelector(
                recipient.handle.selector,
                v2OriginDomain,
                TypeCasts.addressToBytes32(address(this)),
                _messageBody
            )
        );
        testEnvironment.processNextPendingMessage();

        assertEq(recipient.lastData(), _messageBody);
        assertEq(
            recipient.lastSender(),
            TypeCasts.addressToBytes32(address(this))
        );
    }
}
