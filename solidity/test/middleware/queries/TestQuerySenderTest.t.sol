// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {InterchainQueryRouter} from "../../../contracts/middleware/InterchainQueryRouter.sol";
import {TestQuerySender} from "../../../contracts/test/TestQuerySender.sol";
import {MockHyperlaneEnvironment} from "../../../contracts/mock/MockHyperlaneEnvironment.sol";

import {InterchainQueryRouterTest} from "../../InterchainQueryRouter.t.sol";

import {MockToken} from "../../../contracts/mock/MockToken.sol";

contract OwnableContract is Ownable {}

contract TestQuerySenderTest is Test {
    MockHyperlaneEnvironment testEnvironment;
    TestQuerySender sender;
    uint32 originDomain = 123;
    uint32 destinationDomain = 321;
    uint256 testGasAmount = 200000;
    uint256 _gasPayment = 0;

    function setUp() public {
        InterchainQueryRouterTest queryTest = new InterchainQueryRouterTest();
        queryTest.setUp();
        testEnvironment = queryTest.environment();

        sender = new TestQuerySender();
        sender.initialize(address(queryTest.originRouter()));
    }

    function testSendAddressQuery(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        OwnableContract ownable = new OwnableContract();
        // Set the owner
        ownable.transferOwnership(owner);

        sender.queryAddress{value: _gasPayment}(
            destinationDomain,
            address(ownable),
            abi.encodeWithSelector(ownable.owner.selector),
            testGasAmount
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastAddressResult(), owner);
    }

    function skip_testSendAddressQueryRequiresGasPayment() public {
        vm.expectRevert("insufficient interchain gas payment");
        sender.queryAddress{value: 0}(
            destinationDomain,
            address(0),
            bytes(""),
            testGasAmount
        );
    }

    function testSendUint256Query(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        sender.queryUint256{value: _gasPayment}(
            destinationDomain,
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this)),
            testGasAmount
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastUint256Result(), balance);
    }

    function skip_testSendUint256QueryRequiresGasPayment() public {
        vm.expectRevert("insufficient interchain gas payment");
        sender.queryUint256{value: 0}(
            destinationDomain,
            address(0),
            bytes(""),
            testGasAmount
        );
    }

    function testSendBytesQuery(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        sender.queryBytes32{value: _gasPayment}(
            destinationDomain,
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this)),
            testGasAmount
        );

        testEnvironment.processNextPendingMessage();
        testEnvironment.processNextPendingMessageFromDestination();
        assertEq(sender.lastBytes32Result(), bytes32(balance));
    }

    function skip_testSendBytesQueryRequiresGasPayment() public {
        vm.expectRevert("insufficient interchain gas payment");
        sender.queryBytes32{value: 0}(
            destinationDomain,
            address(0),
            bytes(""),
            testGasAmount
        );
    }
}
