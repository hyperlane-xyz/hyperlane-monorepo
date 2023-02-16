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
        bytes32 sender,
        address account
    );

    MockHyperlaneEnvironment environment;

    uint32 originDomain = 1;
    uint32 destinationDomain = 2;

    InterchainAccountRouter originRouter;
    InterchainAccountRouter destinationRouter;
    IInterchainAccountRouter.InterchainAccountConfig userConfig;

    OwnableMulticall ica;

    Callable target;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );

        originRouter = new InterchainAccountRouter();
        destinationRouter = new InterchainAccountRouter();

        address owner = address(this);
        originRouter.initialize(
            address(environment.mailboxes(originDomain)),
            address(environment.igps(originDomain)),
            address(environment.isms(originDomain)),
            owner
        );
        destinationRouter.initialize(
            address(environment.mailboxes(destinationDomain)),
            address(environment.igps(destinationDomain)),
            address(environment.isms(destinationDomain)),
            owner
        );

        userConfig = IInterchainAccountRouter.InterchainAccountConfig({
            router: TypeCasts.addressToBytes32(address(destinationRouter)),
            ism: TypeCasts.addressToBytes32(
                address(environment.isms(destinationDomain))
            )
        });
        ica = destinationRouter.getLocalInterchainAccount(
            originDomain,
            address(this),
            address(environment.isms(destinationDomain))
        );

        target = new Callable();
    }

    function assertEq(
        IInterchainAccountRouter.InterchainAccountConfig memory a,
        IInterchainAccountRouter.InterchainAccountConfig memory b
    ) private {
        assertEq(abi.encode(a), abi.encode(b));
    }

    function testSetGlobalDefaults(bytes32 router, bytes32 ism) public {
        IInterchainAccountRouter.InterchainAccountConfig
            memory actualConfig = originRouter.getInterchainAccountConfig(
                destinationDomain,
                address(this)
            );
        IInterchainAccountRouter.InterchainAccountConfig
            memory expectedConfig = IInterchainAccountRouter
                .InterchainAccountConfig({router: bytes32(0), ism: bytes32(0)});
        assertEq(actualConfig, expectedConfig);
        expectedConfig = IInterchainAccountRouter.InterchainAccountConfig({
            router: router,
            ism: ism
        });
        originRouter.setGlobalDefault(destinationDomain, expectedConfig);
        actualConfig = originRouter.getInterchainAccountConfig(
            destinationDomain,
            address(this)
        );
        assertEq(actualConfig, expectedConfig);
    }

    function testSetGlobalDefaultsImmutable(
        bytes32 routerA,
        bytes32 ismA,
        bytes32 routerB,
        bytes32 ismB
    ) public {
        vm.assume(routerA != bytes32(0) && routerB != bytes32(0));
        originRouter.setGlobalDefault(
            destinationDomain,
            IInterchainAccountRouter.InterchainAccountConfig({
                router: routerA,
                ism: ismA
            })
        );
        vm.expectRevert(bytes("global configs are immutable once set"));
        originRouter.setGlobalDefault(
            destinationDomain,
            IInterchainAccountRouter.InterchainAccountConfig({
                router: routerB,
                ism: ismB
            })
        );
    }

    function testSetGlobalDefaultsNonOwner(
        address newOwner,
        bytes32 router,
        bytes32 ism
    ) public {
        vm.assume(newOwner != address(0) && newOwner != originRouter.owner());
        originRouter.transferOwnership(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        originRouter.setGlobalDefault(
            destinationDomain,
            IInterchainAccountRouter.InterchainAccountConfig({
                router: router,
                ism: ism
            })
        );
    }

    function testSetUserDefaults(
        bytes32 globalRouter,
        bytes32 globalIsm,
        bytes32 userRouter,
        bytes32 userIsm
    ) public {
        // Set global defaults to ensure overridden by user defaults
        originRouter.setGlobalDefault(
            destinationDomain,
            IInterchainAccountRouter.InterchainAccountConfig({
                router: globalRouter,
                ism: globalIsm
            })
        );
        IInterchainAccountRouter.InterchainAccountConfig
            memory expectedConfig = IInterchainAccountRouter
                .InterchainAccountConfig({router: userRouter, ism: userIsm});
        originRouter.setUserDefault(destinationDomain, expectedConfig);
        IInterchainAccountRouter.InterchainAccountConfig
            memory actualConfig = originRouter.getInterchainAccountConfig(
                destinationDomain,
                address(this)
            );
        assertEq(actualConfig, expectedConfig);
    }

    function callRemoteSetter(bytes32 data) private {
        vm.assume(data != bytes32(0));
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(address(target)),
            abi.encodeCall(target.set, (data)),
            0
        );
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        originRouter.callRemote(destinationDomain, calls);
    }

    function testCallRemote(bytes32 data) private {
        assertEq(target.data(address(this)), bytes32(0));
        callRemoteSetter(data);
        vm.expectEmit(true, false, false, true, address(destinationRouter));
        emit InterchainAccountCreated(
            originDomain,
            address(this).addressToBytes32(),
            address(ica)
        );
        environment.processNextPendingMessage();
        assertEq(target.data(address(ica)), data);
    }

    /*
    function testCallRemoteWithConfig(bytes32 value) public {
        testCallRemote(value);
    }
    */

    function testCallRemoteWithGlobalDefault(bytes32 value) public {
        originRouter.setGlobalDefault(destinationDomain, userConfig);
        testCallRemote(value);
    }

    function testCallRemoteWithUserDefault(bytes32 value) public {
        originRouter.setUserDefault(destinationDomain, userConfig);
        testCallRemote(value);
    }

    function testGetLocalInterchainAccount(bytes32 value) public {
        OwnableMulticall destinationIca = destinationRouter
            .getLocalInterchainAccount(
                originDomain,
                address(this),
                address(environment.isms(destinationDomain))
            );
        assertEq(
            address(destinationIca),
            address(
                destinationRouter.getLocalInterchainAccount(
                    originDomain,
                    TypeCasts.addressToBytes32(address(this)),
                    address(environment.isms(destinationDomain))
                )
            )
        );

        assertEq(address(destinationIca).code.length, 0);

        originRouter.setUserDefault(destinationDomain, userConfig);
        callRemoteSetter(value);
        environment.processNextPendingMessage();

        assert(address(destinationIca).code.length != 0);
    }

    function testReceiveValue(uint256 value, bytes32 data) public {
        vm.assume(value > 0 && value <= address(this).balance);

        // receive value before deployed
        assert(address(ica).code.length == 0);
        payable(address(ica)).transfer(value / 2);

        // Deploy
        originRouter.setUserDefault(destinationDomain, userConfig);
        callRemoteSetter(data);
        environment.processNextPendingMessage();

        // receive value after deployed
        destinationRouter.getLocalInterchainAccount(
            originDomain,
            address(this),
            address(environment.isms(originDomain))
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

        originRouter.setUserDefault(destinationDomain, userConfig);
        originRouter.callRemote(destinationDomain, calls);
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }
}
