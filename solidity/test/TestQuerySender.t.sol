// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {InterchainQueryRouter} from "../contracts/middleware/InterchainQueryRouter.sol";
import {TestQuerySender} from "../contracts/test/TestQuerySender.sol";
import {HyperlaneTestEnvironment} from "./HyperlaneTestEnvironment.sol";

import {MockToken} from "../contracts/mock/MockToken.sol";

contract TestQuerySenderTest is Test {
    HyperlaneTestEnvironment testEnvironment;
    TestQuerySender sender;
    uint32 originDomain = 123;
    uint32 destinationDomain = 321;

    function setUp() public {
        testEnvironment = new HyperlaneTestEnvironment(
            originDomain,
            destinationDomain
        );

        sender = new TestQuerySender(
            address(testEnvironment.queryRouters(originDomain))
        );
    }

    function testSendAddressQuery(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        InterchainQueryRouter ownable = new InterchainQueryRouter();
        // Set the routers owner
        ownable.transferOwnership(owner);

        sender.queryAddress(
            destinationDomain,
            address(ownable),
            abi.encodeWithSelector(ownable.owner.selector)
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastAddressResult(), owner);
    }

    function testSendUint256Query(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        sender.queryUint256(
            destinationDomain,
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this))
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastUint256Result(), balance);
    }

    function testSendBytesQuery(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        sender.queryBytes32(
            destinationDomain,
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this))
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastBytes32Result(), bytes32(balance));
    }
}
