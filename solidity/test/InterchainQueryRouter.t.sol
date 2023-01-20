// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {InterchainQueryRouter} from "../contracts/middleware/InterchainQueryRouter.sol";
import {IInterchainQueryRouter} from "../interfaces/IInterchainQueryRouter.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";

import {MockToken} from "../contracts/mock/MockToken.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";
import {OwnableMulticall} from "../contracts/OwnableMulticall.sol";

contract InterchainQueryRouterTest is Test {
    event QueryDispatched(
        uint32 indexed destinationDomain,
        bytes32 indexed queryId
    );
    event QueryReturned(uint32 indexed originDomain, bytes32 indexed queryId);
    event QueryResolved(uint32 indexed destinationDomain);

    MockHyperlaneEnvironment environment;

    InterchainQueryRouter originRouter;
    InterchainQueryRouter remoteRouter;

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

        originRouter = new InterchainQueryRouter();
        remoteRouter = new InterchainQueryRouter();

        address owner = address(this);
        originRouter.initialize(
            address(environment.mailboxes(originDomain)),
            address(environment.igps(originDomain)),
            address(environment.isms(originDomain)),
            owner
        );
        remoteRouter.initialize(
            address(environment.mailboxes(remoteDomain)),
            address(environment.igps(remoteDomain)),
            address(environment.isms(remoteDomain)),
            owner
        );

        originRouter.enrollRemoteRouter(
            remoteDomain,
            TypeCasts.addressToBytes32(address(remoteRouter))
        );
        remoteRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );
    }

    function queryHelper(
        address target,
        bytes memory call,
        bytes memory callback
    ) public {
        vm.expectEmit(true, true, false, false, address(originRouter));
        emit QueryDispatched(remoteDomain, bytes32(0));
        originRouter.query(remoteDomain, address(target), call, callback);

        vm.expectEmit(true, true, false, false, address(remoteRouter));
        emit QueryReturned(originDomain, bytes32(0));
        environment.processNextPendingMessage();

        vm.expectEmit(true, true, false, false, address(originRouter));
        emit QueryResolved(remoteDomain);
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
        OwnableMulticall ownable = new OwnableMulticall();

        originRouter.query(
            remoteDomain,
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
        OwnableMulticall ownable = new OwnableMulticall();

        originRouter.query(
            remoteDomain,
            address(ownable),
            abi.encodePacked(ownable.owner.selector),
            abi.encodePacked(this.badReceiveAddress.selector)
        );
        environment.processNextPendingMessage();
        vm.expectRevert(bytes("bad"));
        environment.processNextPendingMessageFromDestination();
    }

    function testQueryAddress(address owner) public {
        vm.assume(owner != address(0x0));
        // Deploy a random ownable contract
        OwnableMulticall ownable = new OwnableMulticall();
        // Set the routers owner
        ownable.transferOwnership(owner);

        queryHelper(
            address(ownable),
            abi.encodePacked(ownable.owner.selector),
            abi.encodePacked(this.receiveAddress.selector)
        );
        assertEq(addressResult, owner);
    }

    function receiveUint256(uint256 _result) external {
        uint256Result = _result;
    }

    function testQueryUint256(uint256 balance) public {
        vm.assume(balance > 0);

        MockToken token = new MockToken();
        token.mint(address(this), balance);

        queryHelper(
            address(token),
            abi.encodeWithSelector(token.balanceOf.selector, address(this)),
            abi.encodePacked(this.receiveUint256.selector)
        );
        assertEq(uint256Result, balance);
    }
}
