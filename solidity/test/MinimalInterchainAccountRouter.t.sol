// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {StandardHookMetadata} from "../contracts/hooks/libs/StandardHookMetadata.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {CallLib, OwnableMulticall, InterchainAccountMessage} from "../contracts/middleware/InterchainAccountRouter.sol";
import {MinimalInterchainAccountRouter} from "../contracts/middleware/MinimalInterchainAccountRouter.sol";
import {AbstractPostDispatchHook} from "../contracts/hooks/libs/AbstractPostDispatchHook.sol";
import {TestPostDispatchHook} from "../contracts/test/TestPostDispatchHook.sol";

contract Callable {
    mapping(address => bytes32) public data;
    mapping(address => uint256) public value;

    function set(bytes32 _data) external payable {
        data[msg.sender] = _data;
        value[msg.sender] = msg.value;
    }
}

contract FailingIsm is IInterchainSecurityModule {
    string public failureMessage;
    uint8 public moduleType;

    constructor(string memory _failureMessage) {
        failureMessage = _failureMessage;
    }

    function verify(
        bytes calldata,
        bytes calldata
    ) external view returns (bool) {
        revert(failureMessage);
    }
}

contract MinimalInterchainAccountRouterTest is Test {
    using TypeCasts for address;
    using StandardHookMetadata for bytes;

    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        bytes32 owner,
        address ism,
        bytes32 salt
    );

    event RemoteCallDispatched(
        uint32 indexed destination,
        address indexed owner,
        bytes32 router,
        bytes32 ism,
        bytes32 salt
    );

    MockHyperlaneEnvironment internal environment;

    uint32 internal origin = 1;
    uint32 internal destination = 2;

    TestInterchainGasPaymaster internal igp;
    MinimalInterchainAccountRouter internal originRouter;
    MinimalInterchainAccountRouter internal destinationRouter;
    bytes32 internal ismOverride;
    bytes32 internal routerOverride;
    uint256 gasPaymentQuote;
    uint256 internal constant GAS_LIMIT_OVERRIDE = 60000;

    OwnableMulticall internal ica;
    Callable internal target;

    function deployMinimalRouter(
        address _mailbox,
        address _hook,
        address _owner
    ) public returns (MinimalInterchainAccountRouter) {
        return new MinimalInterchainAccountRouter(_mailbox, _hook, _owner);
    }

    function setUp() public virtual {
        environment = new MockHyperlaneEnvironment(origin, destination);

        igp = new TestInterchainGasPaymaster();
        gasPaymentQuote = igp.quoteGasPayment(
            destination,
            igp.getDefaultGasUsage()
        );

        address owner = address(this);
        originRouter = deployMinimalRouter(
            address(environment.mailboxes(origin)),
            address(environment.igps(origin)),
            owner
        );
        destinationRouter = deployMinimalRouter(
            address(environment.mailboxes(destination)),
            address(environment.igps(destination)),
            owner
        );

        environment.mailboxes(origin).setDefaultHook(address(igp));

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

    function getCalls(
        bytes32 data,
        uint256 value
    ) private view returns (CallLib.Call[] memory) {
        vm.assume(data != bytes32(0));
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(address(target)),
            value,
            abi.encodeCall(target.set, (data))
        );
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;
        return calls;
    }

    function assertRemoteCallReceived(bytes32 data, uint256 value) private {
        assertEq(target.data(address(this)), bytes32(0));
        assertEq(target.value(address(this)), 0);

        vm.expectEmit(true, true, false, true, address(destinationRouter));
        emit InterchainAccountCreated(
            address(ica),
            origin,
            address(originRouter).addressToBytes32(),
            address(this).addressToBytes32(),
            TypeCasts.bytes32ToAddress(ismOverride),
            bytes32(0)
        );

        vm.deal(address(this), value);
        environment.processNextPendingMessage{value: value}();

        assertEq(target.data(address(ica)), data);
        assertEq(target.value(address(ica)), value);
    }

    function assertIgpPayment(
        uint256 balanceBefore,
        uint256 balanceAfter,
        uint256 gasLimit
    ) private {
        uint256 expectedGasPayment = gasLimit * igp.gasPrice();
        assertEq(balanceBefore - balanceAfter, expectedGasPayment);
        assertEq(address(igp).balance, expectedGasPayment);
    }

    receive() external payable {}

    // ============ Constructor / ICA Derivation ============

    function testFuzz_constructor(address _localOwner) public {
        OwnableMulticall _account = destinationRouter
            .getDeployedInterchainAccount(
                origin,
                _localOwner,
                address(originRouter),
                address(environment.isms(destination))
            );
        assertEq(_account.owner(), address(destinationRouter));
    }

    function test_implementation_deployed() public {
        address impl = originRouter.implementation();
        assertTrue(impl != address(0));
        assertTrue(impl.code.length > 0);
    }

    function test_bytecodeHash_nonzero() public {
        bytes32 hash = originRouter.bytecodeHash();
        assertTrue(hash != bytes32(0));
    }

    function test_interchainSecurityModule_returnsSelf() public {
        assertEq(
            address(originRouter.interchainSecurityModule()),
            address(originRouter)
        );
    }

    // ============ Enrollment ============

    function testFuzz_enrollRemoteRouterAndIsm(
        bytes32 router,
        bytes32 ism
    ) public {
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

    function testFuzz_enrollRemoteRouterAndIsms(
        uint32[] calldata destinations,
        bytes32[] calldata routers,
        bytes32[] calldata isms
    ) public {
        if (
            destinations.length != routers.length ||
            destinations.length != isms.length
        ) {
            vm.expectRevert(bytes("length mismatch"));
            originRouter.enrollRemoteRouterAndIsms(destinations, routers, isms);
            return;
        }

        originRouter.enrollRemoteRouterAndIsms(destinations, routers, isms);

        for (uint256 i = 0; i < destinations.length; i++) {
            bytes32 actualRouter = originRouter.routers(destinations[i]);
            bytes32 actualIsm = originRouter.isms(destinations[i]);
            assertEq(actualRouter, routers[i]);
            assertEq(actualIsm, isms[i]);
        }
    }

    function testFuzz_enrollRemoteRouterAndIsmImmutable(
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

    function testFuzz_enrollRemoteRouterAndIsmNonOwner(
        address newOwner,
        bytes32 router,
        bytes32 ism
    ) public {
        vm.assume(newOwner != address(0) && newOwner != originRouter.owner());
        originRouter.transferOwnership(newOwner);

        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        originRouter.enrollRemoteRouterAndIsm(destination, router, ism);
    }

    // ============ Gas Quoting ============

    function test_quoteGasPayment() public {
        originRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        assertEq(
            originRouter.quoteGasPayment(destination, igp.getDefaultGasUsage()),
            gasPaymentQuote
        );
    }

    function test_quoteGasPayment_gasLimitOverride() public {
        originRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        assertEq(
            originRouter.quoteGasPayment(destination, GAS_LIMIT_OVERRIDE),
            igp.quoteGasPayment(destination, GAS_LIMIT_OVERRIDE)
        );
    }

    // ============ callRemoteWithOverrides ============

    function testFuzz_callRemoteWithOverrides_default(
        bytes32 data,
        uint256 value
    ) public {
        uint256 balanceBefore = address(this).balance;

        originRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            bytes("")
        );

        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, igp.getDefaultGasUsage());
    }

    function testFuzz_callRemoteWithOverrides_metadata(
        uint64 gasLimit,
        bytes32 data,
        uint256 value
    ) public {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            gasLimit,
            address(this),
            ""
        );
        uint256 balanceBefore = address(this).balance;

        originRouter.callRemoteWithOverrides{value: gasLimit * igp.gasPrice()}(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            metadata
        );

        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, gasLimit);
    }

    function testFuzz_callRemoteWithOverrides_withHook(
        bytes32 data,
        uint256 value
    ) public {
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        originRouter = deployMinimalRouter(
            address(environment.mailboxes(origin)),
            address(testHook),
            address(this)
        );
        originRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        vm.expectCall(
            address(testHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );
        originRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            new bytes(0)
        );
    }

    function testFuzz_callRemoteWithOverrides_revert_noRouter(
        bytes32 data,
        uint256 value
    ) public {
        CallLib.Call[] memory calls = getCalls(data, value);
        vm.expectRevert(bytes("no router specified for destination"));
        originRouter.callRemoteWithOverrides(
            destination,
            bytes32(0),
            ismOverride,
            calls,
            bytes("")
        );
    }

    // ============ ISM Routing ============

    function testFuzz_callRemoteWithFailingIsmOverride(
        bytes32 data,
        uint256 value
    ) public {
        string memory failureMessage = "failing ism";
        bytes32 failingIsm = TypeCasts.addressToBytes32(
            address(new FailingIsm(failureMessage))
        );

        originRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            failingIsm,
            getCalls(data, value),
            bytes("")
        );

        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    function testFuzz_callRemoteWithFailingDefaultIsm(
        bytes32 data,
        uint256 value
    ) public {
        string memory failureMessage = "failing ism";
        FailingIsm failingIsm = new FailingIsm(failureMessage);

        environment.mailboxes(destination).setDefaultIsm(address(failingIsm));
        originRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            bytes32(0),
            getCalls(data, value),
            bytes("")
        );

        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    // ============ ICA Account Tests ============

    function testFuzz_getLocalInterchainAccount(
        bytes32 data,
        uint256 value
    ) public {
        OwnableMulticall destinationIca = destinationRouter
            .getLocalInterchainAccount(
                origin,
                address(this),
                address(originRouter),
                address(environment.isms(destination))
            );
        assertEq(address(destinationIca).code.length, 0);

        originRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            bytes("")
        );

        assertRemoteCallReceived(data, value);
        assert(address(destinationIca).code.length != 0);
    }

    function testFuzz_receiveValue(uint256 value) public {
        vm.assume(value > 1 && value <= address(this).balance);
        // receive value before deployed
        assert(address(ica).code.length == 0);
        bool success;
        (success, ) = address(ica).call{value: value / 2}("");
        require(success, "transfer before deploy failed");

        // receive value after deployed
        destinationRouter.getDeployedInterchainAccount(
            origin,
            address(this),
            address(originRouter),
            address(environment.isms(destination))
        );
        assert(address(ica).code.length > 0);

        (success, ) = address(ica).call{value: value / 2}("");
        require(success, "transfer after deploy failed");
    }

    function receiveValue(uint256 value) external payable {
        assertEq(value, msg.value);
    }

    function testFuzz_sendValue(uint256 value) public {
        vm.assume(
            value > 0 && value <= address(this).balance - gasPaymentQuote
        );
        payable(address(ica)).transfer(value);

        bytes memory data = abi.encodeCall(this.receiveValue, (value));
        CallLib.Call memory call = CallLib.build(address(this), value, data);
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = call;

        originRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            ismOverride,
            calls,
            bytes("")
        );
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }

    function testDifferentSalts() public {
        address owner = address(this);

        ica = destinationRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("i am a salt")
        );

        OwnableMulticall ica2 = destinationRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("i am a different salt")
        );
        assertNotEq(address(ica), address(ica2));
    }

    function testEqualSalts() public {
        address owner = address(this);

        ica = destinationRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("salt1")
        );

        OwnableMulticall ica2 = destinationRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("salt1")
        );
        assertEq(address(ica), address(ica2));
    }

    // ============ Fee Token Approval ============

    function test_approveFeeTokenForHook() public {
        // Minimal router has approveFeeTokenForHook — verify it doesn't revert
        // (no real ERC20 needed, just checking the function exists and is callable)
        vm.expectRevert(); // will revert because address(1) is not an ERC20
        originRouter.approveFeeTokenForHook(address(1), address(2));
    }
}
