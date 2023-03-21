// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/HyperlaneConnectionClient.sol";
import "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {InterchainAccountRouter, IInterchainAccountRouter} from "../contracts/middleware/InterchainAccountRouter.sol";
import {OwnableMulticall} from "../contracts/OwnableMulticall.sol";
import {CallLib} from "../contracts/libs/Call.sol";

contract Callable {
    mapping(address => bytes32) public data;

    function set(bytes32 _data) external {
        data[msg.sender] = _data;
    }
}

contract InterchainAccountRouterTest is Test {
    using TypeCasts for address;

    event InterchainAccountCreated(
        uint32 indexed origin,
        bytes32 indexed owner,
        address ism,
        address account
    );

    struct Bytes32Pair {
        bytes32 a;
        bytes32 b;
    }

    MockHyperlaneEnvironment environment;

    uint32 origin = 1;
    uint32 destination = 2;

    InterchainAccountRouter originRouter;
    InterchainAccountRouter destinationRouter;
    bytes32 ismOverride;
    bytes32 routerOverride;

    OwnableMulticall ica;

    Callable target;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(origin, destination);

        originRouter = new InterchainAccountRouter(origin);
        destinationRouter = new InterchainAccountRouter(destination);

        address owner = address(this);
        originRouter.initialize(
            address(environment.mailboxes(origin)),
            address(environment.igps(destination)),
            address(environment.isms(origin)),
            owner
        );
        destinationRouter.initialize(
            address(environment.mailboxes(destination)),
            address(environment.igps(destination)),
            address(environment.isms(destination)),
            owner
        );

        routerOverride = TypeCasts.addressToBytes32(address(destinationRouter));
        ismOverride = TypeCasts.addressToBytes32(
            address(environment.isms(destination))
        );
        ica = destinationRouter.getLocalInterchainAccount(
            origin,
            address(this),
            address(originRouter),
            address(environment.isms(destination))
        );

        target = new Callable();
    }

    function testGetRemoteInterchainAccount() public {
        address _ica = originRouter.getRemoteInterchainAccount(
            address(this),
            address(destinationRouter),
            address(environment.isms(destination))
        );
        assertEq(_ica, address(ica));
    }

    function testEnrollRemoteRouters(
        uint8 count,
        uint32 domain,
        bytes32 router
    ) public {
        vm.assume(count > 0 && count < uint256(router) && count < domain);
        uint32[] memory domains = new uint32[](count);
        bytes32[] memory routers = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            domains[i] = domain - uint32(i);
            routers[i] = bytes32(uint256(router) - i);
        }
        originRouter.enrollRemoteRouters(domains, routers);
        uint32[] memory actualDomains = originRouter.domains();
        assertEq(actualDomains.length, domains.length);
        for (uint256 i = 0; i < count; i++) {
            bytes32 actualRouter = originRouter.routers(domains[i]);
            bytes32 actualIsm = originRouter.isms(domains[i]);
            assertEq(actualRouter, routers[i]);
            assertEq(actualIsm, bytes32(0));
            assertEq(actualDomains[i], domains[i]);
        }
        assertEq(abi.encode(originRouter.domains()), abi.encode(domains));
    }

    function testEnrollRemoteRouterAndIsm(bytes32 router, bytes32 ism) public {
        vm.assume(router != bytes32(0));
        bytes32 actualRouter = originRouter.routers(destination);
        bytes32 actualIsm = originRouter.isms(destination);
        assertEq(actualRouter, bytes32(0));
        assertEq(actualIsm, bytes32(0));
        originRouter.enrollRemoteRouterAndIsm(destination, router, ism);
        actualRouter = originRouter.routers(destination);
        actualIsm = originRouter.isms(destination);
        assertEq(actualRouter, router);
        assertEq(actualIsm, ism);
    }

    function testEnrollRemoteRouterAndIsmImmutable(
        bytes32 routerA,
        bytes32 ismA,
        bytes32 routerB,
        bytes32 ismB
    ) public {
        vm.assume(routerA != bytes32(0) && routerB != bytes32(0));
        originRouter.enrollRemoteRouterAndIsm(destination, routerA, ismA);
        vm.expectRevert(
            bytes("router and ISM defaults are immutable once set")
        );
        originRouter.enrollRemoteRouterAndIsm(destination, routerB, ismB);
    }

    function testEnrollRemoteRouterAndIsmNonOwner(
        address newOwner,
        bytes32 router,
        bytes32 ism
    ) public {
        vm.assume(newOwner != address(0) && newOwner != originRouter.owner());
        originRouter.transferOwnership(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        originRouter.enrollRemoteRouterAndIsm(destination, router, ism);
    }

    function getCalls(bytes32 data) private returns (CallLib.Call[] memory) {
        vm.assume(data != bytes32(0));
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(address(target)),
            0,
            abi.encodeCall(target.set, (data))
        );
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        return calls;
    }

    function assertRemoteCallReceived(bytes32 data) private {
        assertEq(target.data(address(this)), bytes32(0));
        vm.expectEmit(true, true, false, true, address(destinationRouter));
        emit InterchainAccountCreated(
            origin,
            address(this).addressToBytes32(),
            TypeCasts.bytes32ToAddress(ismOverride),
            address(ica)
        );
        environment.processNextPendingMessage();
        assertEq(target.data(address(ica)), data);
    }

    function testCallRemoteWithDefault(bytes32 data) public {
        originRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        originRouter.callRemote(destination, getCalls(data));
        assertRemoteCallReceived(data);
    }

    function testOverrideAndCallRemote(bytes32 data) public {
        originRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        originRouter.callRemote(destination, getCalls(data));
        assertRemoteCallReceived(data);
    }

    function testCallRemoteWithoutDefaults(bytes32 data) public {
        vm.expectRevert(bytes("no router specified for destination"));
        originRouter.callRemote(destination, getCalls(data));
    }

    function testCallRemoteWithOverrides(bytes32 data) public {
        originRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data)
        );
        assertRemoteCallReceived(data);
    }

    function testGetLocalInterchainAccount(bytes32 data) public {
        OwnableMulticall destinationIca = destinationRouter
            .getLocalInterchainAccount(
                origin,
                address(this),
                address(originRouter),
                address(environment.isms(destination))
            );
        assertEq(
            address(destinationIca),
            address(
                destinationRouter.getLocalInterchainAccount(
                    origin,
                    TypeCasts.addressToBytes32(address(this)),
                    TypeCasts.addressToBytes32(address(originRouter)),
                    address(environment.isms(destination))
                )
            )
        );

        assertEq(address(destinationIca).code.length, 0);

        originRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data)
        );
        assertRemoteCallReceived(data);

        assert(address(destinationIca).code.length != 0);
    }

    function testReceiveValue(uint256 value, bytes32 data) public {
        vm.assume(value > 0 && value <= address(this).balance);

        // receive value before deployed
        assert(address(ica).code.length == 0);
        payable(address(ica)).transfer(value / 2);

        // Deploy
        originRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data)
        );
        assertRemoteCallReceived(data);

        // receive value after deployed
        destinationRouter.getLocalInterchainAccount(
            origin,
            address(this),
            address(originRouter),
            address(environment.isms(origin))
        );

        assert(address(ica).code.length > 0);
        payable(address(ica)).transfer(value / 2);
    }

    // solhint-disable-next-line no-empty-blocks
    function receiveValue() external payable {}

    function testSendValue(uint256 value) public {
        vm.assume(value > 0 && value <= address(this).balance);
        payable(address(ica)).transfer(value);

        bytes memory data = abi.encodeCall(this.receiveValue, ());
        CallLib.Call memory call = CallLib.build(address(this), value, data);
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;

        originRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            calls
        );
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }
}
