// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/HyperlaneConnectionClient.sol";
import "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/middleware/InterchainAccountRouter.sol";
import {OwnableMulticall, Call} from "../contracts/OwnableMulticall.sol";

contract InterchainAccountRouterTest is Test {
    // TODO: dedupe
    event InterchainAccountCreated(
        uint32 indexed origin,
        address sender,
        address account
    );

    MockHyperlaneEnvironment environment;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    InterchainAccountRouter originRouter;
    InterchainAccountRouter remoteRouter;

    TestRecipient recipient;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(originDomain, remoteDomain);

        recipient = new TestRecipient();

        originRouter = new InterchainAccountRouter();
        remoteRouter = new InterchainAccountRouter();

        originRouter.initialize(
            address(environment.mailboxes(originDomain)),
            address(environment.igps(originDomain)),
            address(environment.isms(originDomain))
        );
        remoteRouter.initialize(
            address(environment.mailboxes(remoteDomain)),
            address(environment.igps(remoteDomain)),
            address(environment.isms(remoteDomain))
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

    function testSetOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));

        OwnableMulticall ownee = new OwnableMulticall();
        address ica = remoteRouter.getInterchainAccount(
            originDomain,
            address(this)
        );
        ownee.transferOwnership(ica);

        originRouter.dispatch(
            remoteDomain,
            address(ownee),
            abi.encodeWithSelector(ownee.transferOwnership.selector, newOwner)
        );

        vm.expectEmit(true, false, false, true, address(remoteRouter));
        emit InterchainAccountCreated(originDomain, address(this), ica);
        environment.processNextPendingMessage();

        assertEq(ownee.owner(), newOwner);
    }

    function testOwner() public {
        OwnableMulticall remoteIca = remoteRouter.getDeployedInterchainAccount(
            originDomain,
            address(this)
        );
        assertEq(remoteIca.owner(), address(remoteRouter));

        OwnableMulticall localIca = originRouter.getDeployedInterchainAccount(
            remoteDomain,
            address(this)
        );
        assertEq(localIca.owner(), address(originRouter));
    }
}
