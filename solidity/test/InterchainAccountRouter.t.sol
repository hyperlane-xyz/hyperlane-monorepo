// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {StandardHookMetadata} from "../contracts/hooks/libs/StandardHookMetadata.sol";
import {MockMailbox} from "../contracts/mock/MockMailbox.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {CallLib, OwnableMulticall, InterchainAccountRouter, InterchainAccountMessage} from "../contracts/middleware/InterchainAccountRouter.sol";
import {AbstractPostDispatchHook} from "../contracts/hooks/libs/AbstractPostDispatchHook.sol";
import {TestPostDispatchHook} from "../contracts/test/TestPostDispatchHook.sol";
import {Message} from "../contracts/libs/Message.sol";

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

contract InterchainAccountRouterTestBase is Test {
    using TypeCasts for address;

    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        bytes32 owner,
        address ism,
        bytes32 salt
    );

    MockHyperlaneEnvironment internal environment;

    uint32 internal origin = 1;
    uint32 internal destination = 2;

    TestInterchainGasPaymaster internal igp;
    InterchainAccountRouter internal originIcaRouter;
    InterchainAccountRouter internal destinationIcaRouter;
    bytes32 internal ismOverride;
    bytes32 internal routerOverride;
    uint256 gasPaymentQuote;
    uint256 internal constant GAS_LIMIT_OVERRIDE = 60000;

    OwnableMulticall internal ica;

    Callable internal target;

    function deployIcaRouter(
        MockMailbox _mailbox,
        IPostDispatchHook _customHook,
        address _owner
    ) public returns (InterchainAccountRouter) {
        return
            new InterchainAccountRouter(
                address(_mailbox),
                address(_customHook),
                _owner
            );
    }

    function setUp() public virtual {
        environment = new MockHyperlaneEnvironment(origin, destination);

        igp = new TestInterchainGasPaymaster();
        gasPaymentQuote = igp.quoteGasPayment(
            destination,
            igp.getDefaultGasUsage()
        );

        address owner = address(this);
        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            environment.igps(origin),
            owner
        );

        destinationIcaRouter = deployIcaRouter(
            environment.mailboxes(destination),
            environment.igps(destination),
            owner
        );

        environment.mailboxes(origin).setDefaultHook(address(igp));

        routerOverride = TypeCasts.addressToBytes32(
            address(destinationIcaRouter)
        );
        ismOverride = TypeCasts.addressToBytes32(
            address(environment.isms(destination))
        );
        ica = destinationIcaRouter.getLocalInterchainAccount(
            origin,
            address(this),
            address(originIcaRouter),
            address(environment.isms(destination))
        );

        target = new Callable();
    }

    receive() external payable {}
}

contract InterchainAccountRouterTest is InterchainAccountRouterTestBase {
    using TypeCasts for address;
    using Message for bytes;

    function testFuzz_constructor(address _localOwner) public {
        OwnableMulticall _account = destinationIcaRouter
            .getDeployedInterchainAccount(
                origin,
                _localOwner,
                address(originIcaRouter),
                address(environment.isms(destination))
            );
        assertEq(_account.owner(), address(destinationIcaRouter));
    }

    function testFuzz_getRemoteInterchainAccount(
        address _localOwner,
        address _ism
    ) public {
        address _account = originIcaRouter.getRemoteInterchainAccount(
            address(_localOwner),
            address(destinationIcaRouter),
            _ism
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            TypeCasts.addressToBytes32(_ism)
        );
        assertEq(
            originIcaRouter.getRemoteInterchainAccount(
                destination,
                address(_localOwner)
            ),
            _account
        );
    }

    function testFuzz_enrollRemoteRouters(
        uint8 count,
        uint32 domain,
        bytes32 router
    ) public {
        vm.assume(count > 0 && count < uint256(router) && count < domain);

        // arrange
        // count - # of domains and routers
        uint32[] memory domains = new uint32[](count);
        bytes32[] memory routers = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            domains[i] = domain - uint32(i);
            routers[i] = bytes32(uint256(router) - i);
        }

        // act
        originIcaRouter.enrollRemoteRouters(domains, routers);

        // assert
        uint32[] memory actualDomains = originIcaRouter.domains();
        assertEq(actualDomains.length, domains.length);
        assertEq(abi.encode(originIcaRouter.domains()), abi.encode(domains));

        for (uint256 i = 0; i < count; i++) {
            bytes32 actualRouter = originIcaRouter.routers(domains[i]);
            bytes32 actualIsm = originIcaRouter.isms(domains[i]);

            assertEq(actualRouter, routers[i]);
            assertEq(actualIsm, bytes32(0));
            assertEq(actualDomains[i], domains[i]);
        }
    }

    function testFuzz_enrollRemoteRouterAndIsm(
        bytes32 router,
        bytes32 ism
    ) public {
        vm.assume(router != bytes32(0));

        // arrange pre-condition
        bytes32 actualRouter = originIcaRouter.routers(destination);
        bytes32 actualIsm = originIcaRouter.isms(destination);
        assertEq(actualRouter, bytes32(0));
        assertEq(actualIsm, bytes32(0));

        // act
        originIcaRouter.enrollRemoteRouterAndIsm(destination, router, ism);

        // assert
        actualRouter = originIcaRouter.routers(destination);
        actualIsm = originIcaRouter.isms(destination);
        assertEq(actualRouter, router);
        assertEq(actualIsm, ism);
    }

    function testFuzz_enrollRemoteRouterAndIsms(
        uint32[] calldata destinations,
        bytes32[] calldata routers,
        bytes32[] calldata isms
    ) public {
        // check reverts
        if (
            destinations.length != routers.length ||
            destinations.length != isms.length
        ) {
            vm.expectRevert(bytes("length mismatch"));
            originIcaRouter.enrollRemoteRouterAndIsms(
                destinations,
                routers,
                isms
            );
            return;
        }

        // act
        originIcaRouter.enrollRemoteRouterAndIsms(destinations, routers, isms);

        // assert
        for (uint256 i = 0; i < destinations.length; i++) {
            bytes32 actualRouter = originIcaRouter.routers(destinations[i]);
            bytes32 actualIsm = originIcaRouter.isms(destinations[i]);
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

        // act
        originIcaRouter.enrollRemoteRouterAndIsm(destination, routerA, ismA);

        // assert
        vm.expectRevert(
            bytes("router and ISM defaults are immutable once set")
        );
        originIcaRouter.enrollRemoteRouterAndIsm(destination, routerB, ismB);
    }

    function testFuzz_enrollRemoteRouterAndIsmNonOwner(
        address newOwner,
        bytes32 router,
        bytes32 ism
    ) public {
        vm.assume(
            newOwner != address(0) && newOwner != originIcaRouter.owner()
        );

        // act
        originIcaRouter.transferOwnership(newOwner);

        // assert
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        originIcaRouter.enrollRemoteRouterAndIsm(destination, router, ism);
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

        vm.expectEmit(true, true, false, true, address(destinationIcaRouter));
        emit InterchainAccountCreated(
            address(ica),
            origin,
            address(originIcaRouter).addressToBytes32(),
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

    function test_quoteGasPayment() public {
        // arrange
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // assert
        assertEq(originIcaRouter.quoteGasPayment(destination), gasPaymentQuote);
    }

    function test_quoteGasPayment_gasLimitOverride() public {
        // arrange
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // assert
        assertEq(
            originIcaRouter.quoteGasPayment(
                destination,
                "",
                GAS_LIMIT_OVERRIDE
            ),
            igp.quoteGasPayment(destination, GAS_LIMIT_OVERRIDE)
        );
    }

    function test_quoteDispatch_differentHook() public {
        // arrange
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            testHook,
            address(this)
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // assert
        assertEq(originIcaRouter.quoteGasPayment(destination), 0);
    }

    function testFuzz_singleCallRemoteWithDefault(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        uint256 balanceBefore = address(this).balance;

        // act
        CallLib.Call[] memory calls = getCalls(data, value);
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            TypeCasts.bytes32ToAddress(calls[0].to),
            calls[0].value,
            calls[0].data
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertIgpPayment(balanceBefore, balanceAfter, igp.getDefaultGasUsage());
        assertRemoteCallReceived(data, value);
    }

    function testFuzz_callRemoteWithDefault(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, igp.getDefaultGasUsage());
    }

    function testFuzz_callRemoteWithDefault_differentHook(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            testHook,
            address(this)
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // assert
        vm.expectCall(
            address(testHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );

        // act
        originIcaRouter.callRemote(destination, getCalls(data, value));
    }

    function testFuzz_overrideAndCallRemote(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, igp.getDefaultGasUsage());
    }

    function testFuzz_callRemoteWithoutDefaults_revert_noRouter(
        bytes32 data,
        uint256 value
    ) public {
        // assert error
        CallLib.Call[] memory calls = getCalls(data, value);
        vm.expectRevert(bytes("no router specified for destination"));
        originIcaRouter.callRemote(destination, calls);
    }

    function testFuzz_customMetadata_forIgp(
        uint64 gasLimit,
        uint64 overpayment,
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            gasLimit,
            address(this),
            ""
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{
            value: gasLimit * igp.gasPrice() + overpayment
        }(destination, getCalls(data, value), metadata);

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, gasLimit);
    }

    function testFuzz_customMetadata_reverts_underpayment(
        uint64 gasLimit,
        uint64 payment,
        bytes32 data,
        uint256 value
    ) public {
        CallLib.Call[] memory calls = getCalls(data, value);
        vm.assume(payment < gasLimit * igp.gasPrice());
        // arrange
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            gasLimit,
            address(this),
            ""
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // act
        vm.expectRevert("IGP: insufficient interchain gas payment");
        originIcaRouter.callRemote{value: payment}(
            destination,
            calls,
            metadata
        );
    }

    function testFuzz_callRemoteWithOverrides_default(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, igp.getDefaultGasUsage());
        assertEq(address(originIcaRouter.hook()), address(0));
    }

    function testFuzz_callRemoteWithOverrides_metadata(
        uint64 gasLimit,
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            gasLimit,
            address(this),
            ""
        );
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemoteWithOverrides{
            value: gasLimit * igp.gasPrice()
        }(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            metadata
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, gasLimit);
    }

    function testFuzz_callRemoteWithOverrides_withHook(
        bytes32 data,
        uint256 value
    ) public {
        TestPostDispatchHook testHook = new TestPostDispatchHook();

        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            testHook,
            address(this)
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        vm.expectCall(
            address(testHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );
        originIcaRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            new bytes(0)
        );
    }

    function testFuzz_callRemoteWithFailingIsmOverride(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        string memory failureMessage = "failing ism";
        bytes32 failingIsm = TypeCasts.addressToBytes32(
            address(new FailingIsm(failureMessage))
        );

        // act
        originIcaRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            failingIsm,
            getCalls(data, value),
            bytes("")
        );

        // assert
        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    function testFuzz_callRemoteWithFailingDefaultIsm(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        string memory failureMessage = "failing ism";
        FailingIsm failingIsm = new FailingIsm(failureMessage);

        // act
        environment.mailboxes(destination).setDefaultIsm(address(failingIsm));
        originIcaRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            bytes32(0),
            getCalls(data, value),
            bytes("")
        );

        // assert
        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    function testFuzz_getLocalInterchainAccount(
        bytes32 data,
        uint256 value
    ) public {
        // check
        OwnableMulticall destinationIca = destinationIcaRouter
            .getLocalInterchainAccount(
                origin,
                address(this),
                address(originIcaRouter),
                address(environment.isms(destination))
            );
        assertEq(
            address(destinationIca),
            address(
                destinationIcaRouter.getLocalInterchainAccount(
                    origin,
                    TypeCasts.addressToBytes32(address(this)),
                    TypeCasts.addressToBytes32(address(originIcaRouter)),
                    address(environment.isms(destination))
                )
            )
        );
        assertEq(address(destinationIca).code.length, 0);

        // act
        originIcaRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            bytes("")
        );

        // recheck
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
        destinationIcaRouter.getDeployedInterchainAccount(
            origin,
            address(this),
            address(originIcaRouter),
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

        originIcaRouter.callRemoteWithOverrides{value: gasPaymentQuote}(
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

        ica = destinationIcaRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originIcaRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("i am a salt")
        );

        OwnableMulticall ica2 = destinationIcaRouter
            .getDeployedInterchainAccount(
                origin,
                owner.addressToBytes32(),
                address(originIcaRouter).addressToBytes32(),
                address(environment.isms(destination)),
                keccak256("i am a different salt")
            );
        assertNotEq(address(ica), address(ica2));
    }

    function testEqualSalts() public {
        address owner = address(this);

        ica = destinationIcaRouter.getDeployedInterchainAccount(
            origin,
            owner.addressToBytes32(),
            address(originIcaRouter).addressToBytes32(),
            address(environment.isms(destination)),
            keccak256("salt1")
        );

        OwnableMulticall ica2 = destinationIcaRouter
            .getDeployedInterchainAccount(
                origin,
                owner.addressToBytes32(),
                address(originIcaRouter).addressToBytes32(),
                address(environment.isms(destination)),
                keccak256("salt1")
            );
        assertEq(address(ica), address(ica2));
    }

    function testFuzz_callRemoteWithCustomHook(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        TestPostDispatchHook customHook = new TestPostDispatchHook();

        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            testHook,
            address(this)
        );
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // assert
        vm.expectCall(
            address(customHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );

        // act
        originIcaRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(data, value),
            new bytes(0),
            bytes32(0),
            customHook
        );
    }

    function testFuzz_callRemoteCommitReveal(bytes32 commitment) public {
        // act
        originIcaRouter.callRemoteCommitReveal(
            destination,
            routerOverride,
            ismOverride,
            bytes(""),
            new TestPostDispatchHook(),
            bytes32(0),
            commitment
        );

        // Process message
        environment.processNextPendingMessage();

        // assert
        // ICA router should have the commitment
        assertEq(ica.commitment(), commitment);
    }

    function testFuzz_revealAndExecute(
        bytes32 data,
        uint256 value,
        bytes32 salt
    ) public {
        // Arrange
        CallLib.Call[] memory calls = getCalls(data, value);
        bytes32 commitment = keccak256(abi.encode(calls, salt, ica));
        deal(address(ica), value); // Ensure ICA has enough balance to execute calls

        // Act
        originIcaRouter.callRemoteCommitReveal(
            destination,
            routerOverride,
            ismOverride,
            bytes(""),
            new TestPostDispatchHook(),
            bytes32(0),
            commitment
        );
        // Process commit message
        environment.processNextPendingMessage();

        // ICA router should have the commitment after commit message
        assertEq(ica.commitment(), commitment);

        // Manually process the reveal. In reality, the CCIP read ISM will call `revealAndExecute`
        // but here we do it manually since we're not using the CCIP read ISM yet
        bytes32 executedCommitment = destinationIcaRouter.revealAndExecute(
            calls,
            salt,
            ica
        );

        // Commitment should be cleared
        assertEq(executedCommitment, commitment);
        assertEq(ica.commitment(), bytes32(0));

        // Cannot reveal twice
        executedCommitment = destinationIcaRouter.revealAndExecute(
            calls,
            salt,
            ica
        );
        assertEq(executedCommitment, bytes32(0));
    }

    function testFuzz_readIsm_verify(
        bytes32 data,
        uint256 value,
        bytes32 salt
    ) public {
        // Arrange
        CallLib.Call[] memory calls = getCalls(data, value);
        bytes32 commitment = keccak256(abi.encode(calls, salt, ica));
        deal(address(ica), value); // Ensure ICA has enough balance to execute calls

        // Act
        originIcaRouter.callRemoteCommitReveal(
            destination,
            routerOverride,
            ismOverride,
            bytes(""),
            new TestPostDispatchHook(),
            bytes32(0),
            commitment
        );
        // Process commit message
        environment.processNextPendingMessage();

        // ICA router should have the commitment after commit message
        assertEq(ica.commitment(), commitment);

        // Process reveal message
        MockMailbox _mailbox = MockMailbox(
            address(destinationIcaRouter.mailbox())
        );
        bytes memory message = _mailbox.inboundMessages(1);
        bytes memory metadata = abi.encode(calls, salt, ica);
        destinationIcaRouter.CCIP_READ_ISM().process(metadata, message);

        // Commitment should be cleared
        assertEq(ica.commitment(), bytes32(0));
    }

    function testFuzz_callRemoteCommitReveal_simpleOverload(
        bytes32 commitment
    ) public {
        // Arrange
        gasPaymentQuote = igp.quoteGasPayment(
            destination,
            100_000 + originIcaRouter.COMMIT_TX_GAS_USAGE()
        );
        deal(address(this), gasPaymentQuote);
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        // Act
        originIcaRouter.callRemoteCommitReveal{value: gasPaymentQuote}(
            destination,
            commitment,
            100_000
        );

        // Process message
        environment.processNextPendingMessage();

        // Assert
        // ICA router should have the commitment
        assertEq(ica.commitment(), commitment);
    }

    function testFuzz_quoteGasForCommitReveal(bytes32 commitment) public {
        // Arrange
        // We use _Router_quoteDispatch so we actually need a remote router enrolled before quoting
        originIcaRouter.enrollRemoteRouterAndIsm(
            destination,
            routerOverride,
            ismOverride
        );

        uint gasLimitForExecutingCalls = 100_000;
        uint quote = originIcaRouter.quoteGasForCommitReveal(
            destination,
            gasLimitForExecutingCalls
        );

        uint directIGPQuote = igp.quoteGasPayment(
            origin,
            gasLimitForExecutingCalls + originIcaRouter.COMMIT_TX_GAS_USAGE()
        );

        // Assert
        // The ICA Router gets it quote by passing fixed gas plus variable gas to the IGP
        assertEq(quote, directIGPQuote);
    }

    function test_ReadIsmOwnership() public {
        assertEq(
            originIcaRouter.CCIP_READ_ISM().owner(),
            originIcaRouter.owner()
        );

    }
}
