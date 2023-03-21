// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/HyperlaneConnectionClient.sol";
import "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/middleware/InterchainAccountRouter.sol";
import {TestHyperlaneConnectionClient} from "../contracts/test/TestHyperlaneConnectionClient.sol";
import {CallLib} from "../contracts/libs/Call.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract InterchainAccountRouterTest is Test {
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

    TestHyperlaneConnectionClient ownable;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(originDomain, remoteDomain);

        recipient = new TestRecipient();

        originRouter = new InterchainAccountRouter(address(0));
        remoteRouter = new InterchainAccountRouter(address(0));

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
        ownable = new TestHyperlaneConnectionClient();
    }

    function testConstructor() public {
        address caller = address(this);
        // nonzero caller
        InterchainAccountRouter router = new InterchainAccountRouter(caller);
        OwnableMulticall ica = router.getDeployedInterchainAccount(
            originDomain,
            address(this)
        );
        assertEq(ica.owner(), caller);

        // zero caller
        router = new InterchainAccountRouter(address(0));
        ica = router.getDeployedInterchainAccount(originDomain, address(this));
        assertEq(ica.owner(), address(router));
    }

    function dispatchTransferOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));
        CallLib.Call memory call = CallLib.build(
            address(ownable),
            0,
            abi.encodeCall(ownable.transferOwnership, (newOwner))
        );
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

    function testBytes32Owner() public {
        OwnableMulticall remoteIca = remoteRouter.getDeployedInterchainAccount(
            originDomain,
            address(this).addressToBytes32()
        );
        assertEq(remoteIca.owner(), address(remoteRouter));

        OwnableMulticall localIca = originRouter.getDeployedInterchainAccount(
            remoteDomain,
            address(this).addressToBytes32()
        );
        assertEq(localIca.owner(), address(originRouter));
    }

    function testReceiveValue(uint256 value) public {
        vm.assume(value > 1 && value <= address(this).balance);

        // receive value before deployed
        assert(ica.code.length == 0);
        bool success;
        (success, ) = ica.call{value: value / 2}("");
        require(success, "transfer before deploy failed");

        // receive value after deployed
        remoteRouter.getDeployedInterchainAccount(originDomain, address(this));
        assert(ica.code.length > 0);

        (success, ) = ica.call{value: value / 2}("");
        require(success, "transfer after deploy failed");
    }

    function receiveValue(uint256 value) external payable {
        assertEq(value, msg.value);
    }

    function testSendValue(uint256 value) public {
        vm.assume(value > 0 && value <= address(this).balance);
        ica.transfer(value);

        bytes memory data = abi.encodeCall(this.receiveValue, (value));
        CallLib.Call memory call = CallLib.build(address(this), value, data);
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;

        originRouter.dispatch(remoteDomain, calls);
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }
}
