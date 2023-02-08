// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TestInterchainGasPaymaster} from "../../../contracts/test/TestInterchainGasPaymaster.sol";
import {InterchainQueryRouter} from "../../../contracts/middleware/InterchainQueryRouter.sol";
import {TestQuerySender} from "../../../contracts/test/TestQuerySender.sol";
import {MockHyperlaneEnvironment} from "../../../contracts/mock/MockHyperlaneEnvironment.sol";

import {MockToken} from "../../../contracts/mock/MockToken.sol";

contract OwnableContract is Ownable {}

contract TestQuerySenderTest is Test {
    MockHyperlaneEnvironment testEnvironment;
    TestInterchainGasPaymaster igp;
    TestQuerySender sender;
    uint32 originDomain = 123;
    uint32 destinationDomain = 321;
    uint256 testGasAmount = 200000;

    function setUp() public {
        testEnvironment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );
        igp = testEnvironment.igps(originDomain);
        igp.setGasPrice(1);

        sender = new TestQuerySender();
        sender.initialize(
            address(testEnvironment.queryRouters(originDomain)),
            address(igp)
        );
    }

    function testSendAddressQuery(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        OwnableContract ownable = new OwnableContract();
        // Set the owner
        ownable.transferOwnership(owner);

        uint256 _gasPayment = igp.quoteGasPayment(
            destinationDomain,
            testGasAmount
        );
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

    function testSendAddressQueryRequiresGasPayment() public {
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

        uint256 _gasPayment = igp.quoteGasPayment(
            destinationDomain,
            testGasAmount
        );
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

    function testSendUint256QueryRequiresGasPayment() public {
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

        uint256 _gasPayment = igp.quoteGasPayment(
            destinationDomain,
            testGasAmount
        );
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

    function testSendBytesQueryRequiresGasPayment() public {
        vm.expectRevert("insufficient interchain gas payment");
        sender.queryBytes32{value: 0}(
            destinationDomain,
            address(0),
            bytes(""),
            testGasAmount
        );
    }
}
