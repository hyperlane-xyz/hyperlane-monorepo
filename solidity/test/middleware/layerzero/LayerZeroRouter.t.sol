// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../../../contracts/test/TestRecipient.sol";
import {MockLayerZeroRouter} from "../../../contracts/middleware/layerzero/MockLayerZeroRouter.sol";
import {MockHyperlaneEnvironment, MockMailbox} from "../../../contracts/mock/MockHyperlaneEnvironment.sol";

import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";

contract LayerZeroRouterTest is Test {
    MockHyperlaneEnvironment testEnvironment;

    MockLayerZeroRouter originRouter;
    MockLayerZeroRouter destinationRouter;

    TestRecipient recipient;

    uint16 lzOriginDomain = 123;
    uint16 lzDestinationDomain = 321;

    uint32 hlOriginDomain = 456;
    uint32 hlDestinationDomain = 654;

    address owner = vm.addr(123);

    function setUp() public {
        console.log("Owner Address: %s", owner);

        originRouter = new MockLayerZeroRouter();
        destinationRouter = new MockLayerZeroRouter();

        testEnvironment = new MockHyperlaneEnvironment(
            hlOriginDomain,
            hlDestinationDomain
        );

        console.log("Origin Router Address: %s", address(originRouter));
        console.log(
            "Origin Mailbox: %s",
            address(testEnvironment.mailboxes(hlOriginDomain))
        );
        console.log(
            "Destination Router Address: %s",
            address(destinationRouter)
        );
        console.log(
            "Destination Mailbox: %s",
            address(testEnvironment.mailboxes(hlDestinationDomain))
        );

        originRouter.initialize(
            owner,
            address(testEnvironment.mailboxes(hlOriginDomain)),
            address(testEnvironment.igps(hlOriginDomain)),
            address(testEnvironment.isms(hlOriginDomain))
        );

        destinationRouter.initialize(
            owner,
            address(testEnvironment.mailboxes(hlDestinationDomain)),
            address(testEnvironment.igps(hlDestinationDomain)),
            address(testEnvironment.isms(hlDestinationDomain))
        );

        uint16[] memory lzDomains = new uint16[](2);
        lzDomains[0] = lzOriginDomain;
        lzDomains[1] = lzDestinationDomain;

        uint32[] memory hlDomains = new uint32[](2);
        hlDomains[0] = hlOriginDomain;
        hlDomains[1] = hlDestinationDomain;

        originRouter.mapDomains(lzDomains, hlDomains);
        destinationRouter.mapDomains(lzDomains, hlDomains);

        originRouter.enrollRemoteRouter(
            hlDestinationDomain,
            TypeCasts.addressToBytes32(address(destinationRouter))
        );
        destinationRouter.enrollRemoteRouter(
            hlOriginDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );

        recipient = new TestRecipient();

        //Set expected gas usage
        uint256 gasEstimate = 0.01 ether;
        originRouter.setEstGasAmount(gasEstimate);
        destinationRouter.setEstGasAmount(gasEstimate);
    }

    function testCanSendMessage(bytes calldata _messageBody) public {
        uint256 gasPrice = 100000000000000000000; //Need fix here

        address a = address(recipient);
        address b = msg.sender;
        bytes memory destination = abi.encodePacked(a, b);

        console.log("Recipient: %s", a);
        console.log("Sender: %s", b);

        bytes memory payload = abi.encode("abc");

        originRouter.send{value: gasPrice}(
            lzDestinationDomain,
            destination,
            payload,
            payable(address(0)),
            address(0),
            ""
        );

        bytes32 senderAsBytes32 = TypeCasts.addressToBytes32(
            address(originRouter)
        );

        vm.expectCall(
            address(recipient),
            abi.encodeWithSelector(
                recipient.handle.selector,
                hlOriginDomain,
                senderAsBytes32,
                payload
            )
        );
        testEnvironment.processNextPendingMessage();

        assertEq(recipient.lastData(), payload);
        assertEq(recipient.lastSender(), senderAsBytes32);

        bytes memory destinationAs32 = abi.encode(address(recipient));

        originRouter.send{value: gasPrice}(
            lzDestinationDomain,
            destinationAs32,
            payload,
            payable(address(0)),
            address(0),
            ""
        );

        vm.expectCall(
            address(recipient),
            abi.encodeWithSelector(
                recipient.handle.selector,
                hlOriginDomain,
                senderAsBytes32,
                payload
            )
        );
        testEnvironment.processNextPendingMessage();

        assertEq(recipient.lastData(), payload);
        assertEq(recipient.lastSender(), senderAsBytes32);
    }

    function testCanReceiveMessage(bytes calldata _messageBody) public {
        uint256 gasPrice = 100000000000000000000; //Need fix here

        address a = address(destinationRouter);
        address b = msg.sender;
        bytes memory destination = abi.encodePacked(a, b);

        console.log("Recipient: %s", a);
        console.log("Sender: %s", b);

        bytes memory payload = abi.encode("abc");

        originRouter.send{value: gasPrice}(
            lzDestinationDomain,
            destination,
            payload,
            payable(address(0)),
            address(0),
            ""
        );

        bytes32 senderAsBytes32 = TypeCasts.addressToBytes32(
            address(originRouter)
        );

        vm.expectCall(
            address(destinationRouter),
            abi.encodeWithSelector(
                destinationRouter.handle.selector,
                hlOriginDomain,
                senderAsBytes32,
                payload
            )
        );
        testEnvironment.processNextPendingMessage();
    }
}
