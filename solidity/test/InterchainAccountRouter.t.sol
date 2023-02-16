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

    OwnableMulticall ownable;

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

        ownable = new OwnableMulticall();
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

    /*
    function testSetGlobalDefaultsImmutable(
        bytes32 routerA,
        bytes32 ismA,
        bytes32 routerB,
        bytes32 ismB
    ) public {
        originRouter.setGlobalDefault(
            destinationDomain,
            IInterchainAccountRouter.InterchainAccountConfig({
                router: routerA,
                ism: ismA
            })
        );
        vm.expectRevert(bytes("cannot overwrite global default"));
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
    */

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

    function callRemoteTransferOwner(address newOwner) private {
        vm.assume(newOwner != address(0x0));
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(address(ownable)),
            abi.encodeCall(ownable.transferOwnership, (newOwner)),
            0
        );
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        originRouter.callRemote(destinationDomain, calls);
    }

    function testCallRemote(address newOwner) private {
        callRemoteTransferOwner(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        environment.processNextPendingMessage();

        ownable.transferOwnership(address(ica));

        callRemoteTransferOwner(newOwner);

        vm.expectEmit(true, false, false, true, address(destinationRouter));
        emit InterchainAccountCreated(
            originDomain,
            address(this).addressToBytes32(),
            address(ica)
        );
        environment.processNextPendingMessage();

        assertEq(ownable.owner(), newOwner);
    }

    /*
    function testCallRemoteWithConfig(address newOwner) public {
        testCallRemote(newOwner);
    }
    */

    function testCallRemoteWithGlobalDefault(address newOwner) public {
        originRouter.setGlobalDefault(destinationDomain, userConfig);
        testCallRemote(newOwner);
    }

    function testCallRemoteWithUserDefault(address newOwner) public {
        originRouter.setUserDefault(destinationDomain, userConfig);
        testCallRemote(newOwner);
    }

    function testGetLocalInterchainAccount(address newOwner) public {
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

        ownable.transferOwnership(address(ica));
        originRouter.setUserDefault(destinationDomain, userConfig);
        callRemoteTransferOwner(newOwner);
        environment.processNextPendingMessage();

        assert(address(destinationIca).code.length != 0);
    }

    function testReceiveValue(uint256 value) public {
        vm.assume(value > 0 && value <= address(this).balance);

        // receive value before deployed
        assert(address(ica).code.length == 0);
        payable(address(ica)).transfer(value / 2);

        // Deploy
        ownable.transferOwnership(address(ica));
        originRouter.setUserDefault(destinationDomain, userConfig);
        callRemoteTransferOwner(address(this));
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
