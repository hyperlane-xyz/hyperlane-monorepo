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
import {CallLib} from "../contracts/libs/Call.sol";

contract InterchainAccountRouterTest is Test {
    using CallLib for address;
    using TypeCasts for address;

    event InterchainAccountCreated(
        uint32 indexed origin,
        bytes32 sender,
        address account
    );

    MockHyperlaneEnvironment environment;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    InterchainAccountRouter originRouter;
    InterchainAccountRouter remoteRouter;

    TestRecipient recipient;
    address payable ica;

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

    function dispatchTransferOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));
        CallLib.Call memory call = CallLib.Call({
            to: address(ownable),
            data: abi.encodeCall(ownable.transferOwnership, (newOwner)),
            value: 0
        });
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        originRouter.dispatch(remoteDomain, calls);
    }

    function testCannotSetOwner(address newOwner) public {
        dispatchTransferOwner(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        environment.processNextPendingMessage();
    }

    function testSetOwner(address newOwner) public {
        ownable.transferOwnership(ica);

        dispatchTransferOwner(newOwner);

        vm.expectEmit(true, false, false, true, address(remoteRouter));
        emit InterchainAccountCreated(
            originDomain,
            address(this).addressToBytes32(),
            ica
        );
        environment.processNextPendingMessage();

        assertEq(ownable.owner(), newOwner);
    }

    function testCannotSetOwnerTwice(address newOwner) public {
        vm.assume(newOwner != address(0x0) && newOwner != ica);
        ownable.transferOwnership(ica);

        dispatchTransferOwner(newOwner);
        environment.processNextPendingMessage();

        dispatchTransferOwner(address(this));
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

    function testReceiveValue(uint256 value) public {
        vm.assume(value > 0 && value <= address(this).balance);

        // receive value before deployed
        assert(ica.code.length == 0);
        ica.transfer(value / 2);

        // receive value after deployed
        remoteRouter.getDeployedInterchainAccount(originDomain, address(this));
        assert(ica.code.length > 0);
        ica.transfer(value / 2);
    }

    // solhint-disable-next-line no-empty-blocks
    function receiveValue() external payable {}

    function testSendValue(uint256 value) public {
        vm.assume(value > 0 && value <= address(this).balance);
        ica.transfer(value);

        bytes memory data = abi.encodeCall(this.receiveValue, ());
        CallLib.Call memory call = CallLib.Call({
            to: address(this),
            data: data,
            value: value
        });
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;

        originRouter.dispatch(remoteDomain, calls);
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }
}
