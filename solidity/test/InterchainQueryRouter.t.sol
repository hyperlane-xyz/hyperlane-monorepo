// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {CallLib, InterchainQueryRouter} from "../contracts/middleware/InterchainQueryRouter.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";

import {MockToken} from "../contracts/mock/MockToken.sol";
import {PausableHook} from "../contracts/hooks/PausableHook.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";

contract InterchainQueryRouterTest is Test {
    using TypeCasts for address;

    event QueryDispatched(
        uint32 indexed destinationDomain,
        address indexed sender
    );
    event QueryExecuted(uint32 indexed originDomain, bytes32 indexed sender);
    event QueryResolved(
        uint32 indexed destinationDomain,
        address indexed sender
    );

    MockHyperlaneEnvironment public environment;

    InterchainQueryRouter public originRouter;
    InterchainQueryRouter public remoteRouter;

    TestRecipient recipient;

    uint32 originDomain;
    uint32 remoteDomain;

    address addressResult;
    uint256 uint256Result;

    function setUp() public {
        originDomain = 123;
        remoteDomain = 321;

        environment = new MockHyperlaneEnvironment(originDomain, remoteDomain);

        recipient = new TestRecipient();

        address originMailbox = address(environment.mailboxes(originDomain));
        address remoteMailbox = address(environment.mailboxes(remoteDomain));

        originRouter = new InterchainQueryRouter(originMailbox);
        remoteRouter = new InterchainQueryRouter(remoteMailbox);

        originRouter.enrollRemoteRouter(
            remoteDomain,
            TypeCasts.addressToBytes32(address(remoteRouter))
        );
        remoteRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );
    }

    function dispatchQuery(
        address target,
        bytes memory call,
        bytes memory callback
    ) public {
        vm.expectEmit(true, true, false, true, address(originRouter));
        emit QueryDispatched(remoteDomain, address(this));
        originRouter.query(remoteDomain, target, call, callback);
    }

    function processQuery() public {
        vm.expectEmit(true, true, false, true, address(remoteRouter));
        emit QueryExecuted(originDomain, address(this).addressToBytes32());
        environment.processNextPendingMessage();

        vm.expectEmit(true, true, false, true, address(originRouter));
        emit QueryResolved(remoteDomain, address(this));
        environment.processNextPendingMessageFromDestination();
    }

    function receiveAddress(address _result) external {
        addressResult = _result;
    }

    function badReceiveAddress(address _result) external {
        addressResult = _result;
        revert("bad");
    }

    function testCannotQueryReverting() public {
        // Deploy a random ownable contract
        PausableHook ownable = new PausableHook();
        dispatchQuery(
            address(ownable),
            abi.encodeWithSelector(
                ownable.transferOwnership.selector,
                address(this)
            ),
            abi.encodePacked(this.receiveAddress.selector)
        );
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        environment.processNextPendingMessage();
    }

    function testCannotCallbackReverting() public {
        // Deploy a random ownable contract
        PausableHook ownable = new PausableHook();

        dispatchQuery(
            address(ownable),
            abi.encodePacked(ownable.owner.selector),
            abi.encodePacked(this.badReceiveAddress.selector)
        );
        environment.processNextPendingMessage();
        vm.expectRevert(bytes("bad"));
        environment.processNextPendingMessageFromDestination();
    }

    function testSingleQueryAddress(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        PausableHook ownable = new PausableHook();
        // Set the routers owner
        ownable.transferOwnership(owner);

        vm.expectEmit(true, true, false, true, address(originRouter));
        emit QueryDispatched(remoteDomain, address(this));

        originRouter.query(
            remoteDomain,
            address(ownable),
            abi.encodePacked(ownable.owner.selector),
            abi.encodePacked(this.receiveAddress.selector)
        );
        processQuery();
        assertEq(addressResult, owner);
    }

    function testQueryAddress(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        PausableHook ownable = new PausableHook();
        // Set the routers owner
        ownable.transferOwnership(owner);

        dispatchQuery(
            address(ownable),
            abi.encodePacked(ownable.owner.selector),
            abi.encodePacked(this.receiveAddress.selector)
        );
        processQuery();
        assertEq(addressResult, owner);
    }

    function receiveUint256(uint256 _result) external {
        uint256Result = _result;
    }

    function testQueryUint256(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        dispatchQuery(
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this)),
            abi.encodePacked(this.receiveUint256.selector)
        );
        processQuery();
        assertEq(uint256Result, balance);
    }
}
