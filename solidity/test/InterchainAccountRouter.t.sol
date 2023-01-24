// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/HyperlaneConnectionClient.sol";
import "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/middleware/InterchainAccountRouter.sol";
import {OwnableMulticall} from "../contracts/OwnableMulticall.sol";

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
    address ica;

    OwnableMulticall ownable;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(originDomain, remoteDomain);

        recipient = new TestRecipient();

        originRouter = new InterchainAccountRouter();
        remoteRouter = new InterchainAccountRouter();

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

        ica = remoteRouter.getInterchainAccount(originDomain, address(this));
        ownable = new OwnableMulticall();
    }

    function testCannotSetOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));
        originRouter.dispatch(
            remoteDomain,
            address(ownable),
            abi.encodeWithSelector(ownable.transferOwnership.selector, newOwner)
        );

        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        environment.processNextPendingMessage();
    }

    function testSetOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));

        ownable.transferOwnership(ica);

        originRouter.dispatch(
            remoteDomain,
            address(ownable),
            abi.encodeWithSelector(ownable.transferOwnership.selector, newOwner)
        );

        vm.expectEmit(true, false, false, true, address(remoteRouter));
        emit InterchainAccountCreated(originDomain, address(this), ica);
        environment.processNextPendingMessage();

        assertEq(ownable.owner(), newOwner);
    }

    function testCannotSetOwnerTwice(address newOwner) public {
        vm.assume(newOwner != address(0x0) && newOwner != ica);
        ownable.transferOwnership(ica);

        CallLib.Call memory transferOwner = CallLib.Call({
            to: address(ownable),
            data: abi.encodeWithSelector(
                ownable.transferOwnership.selector,
                newOwner
            )
        });
        CallLib.Call[] memory calls = new CallLib.Call[](2);
        calls[0] = transferOwner;
        calls[1] = transferOwner;
        originRouter.dispatch(remoteDomain, calls);

        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        environment.processNextPendingMessage();
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
