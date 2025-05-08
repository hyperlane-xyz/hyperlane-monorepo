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
import {AccountConfig, CallLib, OwnableMulticall, InterchainAccountRouter} from "../contracts/middleware/InterchainAccountRouter.sol";
import {InterchainAccountIsm} from "../contracts/isms/routing/InterchainAccountIsm.sol";
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

contract InterchainAccountRouterTestBase is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    event InterchainAccountCreated(
        address indexed account,
        uint32 origin,
        bytes32 router,
        AccountConfig config
    );

    MockHyperlaneEnvironment internal environment;

    uint32 internal origin = 1;
    uint32 internal destination = 2;

    TestInterchainGasPaymaster internal igp;
    InterchainAccountIsm internal icaIsm;
    InterchainAccountRouter internal originIcaRouter;
    InterchainAccountRouter internal destinationIcaRouter;
    bytes32 internal ismOverride;
    bytes32 internal routerOverride;
    uint256 gasPaymentQuote;
    uint256 internal constant GAS_LIMIT_OVERRIDE = 60000;

    AccountConfig internal config;
    OwnableMulticall internal ica;

    Callable internal target;

    function deployIcaRouter(
        MockMailbox _mailbox,
        IPostDispatchHook _customHook,
        IInterchainSecurityModule _ism,
        address _owner
    ) public returns (InterchainAccountRouter) {
        return
            new InterchainAccountRouter(
                address(_mailbox),
                address(_customHook),
                address(_ism),
                _owner
            );
    }

    function setUp() public virtual {
        environment = new MockHyperlaneEnvironment(origin, destination);

        igp = new TestInterchainGasPaymaster();
        gasPaymentQuote = igp.quoteGasPayment(destination, GAS_LIMIT_OVERRIDE);

        icaIsm = new InterchainAccountIsm(
            address(environment.mailboxes(destination))
        );

        address owner = address(this);
        originIcaRouter = deployIcaRouter(
            environment.mailboxes(origin),
            environment.igps(origin),
            icaIsm,
            owner
        );

        destinationIcaRouter = deployIcaRouter(
            environment.mailboxes(destination),
            environment.igps(destination),
            icaIsm,
            owner
        );

        routerOverride = address(
            deployIcaRouter(
                environment.mailboxes(destination),
                environment.igps(destination),
                icaIsm,
                owner
            )
        ).addressToBytes32();

        originIcaRouter.enrollRemoteRouter(
            destination,
            address(destinationIcaRouter).addressToBytes32()
        );
        destinationIcaRouter.enrollRemoteRouter(
            origin,
            address(originIcaRouter).addressToBytes32()
        );

        environment.mailboxes(origin).setDefaultHook(address(igp));

        ismOverride = TypeCasts.addressToBytes32(
            address(environment.isms(destination))
        );
        config = AccountConfig({
            owner: address(this).addressToBytes32(),
            ism: bytes32(0),
            salt: bytes32(0)
        });
        ica = OwnableMulticall(
            destinationIcaRouter.getLocalInterchainAccount(origin, config)
        );

        target = new Callable();
    }

    receive() external payable {}
}

contract InterchainAccountRouterTest is InterchainAccountRouterTestBase {
    using TypeCasts for address;

    function testFuzz_constructor() public {
        OwnableMulticall _account = destinationIcaRouter
            .getDeployedInterchainAccount(origin, config);
        assertEq(_account.owner(), address(destinationIcaRouter));
    }

    function testFuzz_quoteCallRemote(uint256 gasLimit) public view {
        vm.assume(gasLimit < 1e18);
        assertEq(
            originIcaRouter.quoteCallRemote(destination, gasLimit),
            igp.quoteGasPayment(destination, gasLimit)
        );
    }

    function testFuzz_getInterchainAccount(
        AccountConfig memory fuzzConfig
    ) public view {
        assertEq(
            originIcaRouter.getRemoteInterchainAccount(destination, fuzzConfig),
            destinationIcaRouter.getLocalInterchainAccount(origin, fuzzConfig)
        );
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
            config
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

    function test_quoteDispatch_differentHook() public {
        // arrange
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        originIcaRouter.setHook(address(testHook));

        // assert
        assertEq(
            originIcaRouter.quoteCallRemote(destination, GAS_LIMIT_OVERRIDE),
            0
        );
    }

    function testFuzz_singleCallRemoteWithDefault(
        bytes32 data,
        uint256 value
    ) public {
        uint256 balanceBefore = address(this).balance;

        CallLib.Call[] memory calls = getCalls(data, value);

        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            TypeCasts.bytes32ToAddress(calls[0].to),
            calls[0].value,
            calls[0].data
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertIgpPayment(balanceBefore, balanceAfter, GAS_LIMIT_OVERRIDE);
        assertRemoteCallReceived(data, value);
    }

    function testFuzz_callRemoteWithDefault(
        bytes32 data,
        uint256 value
    ) public {
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, GAS_LIMIT_OVERRIDE);
    }

    function testFuzz_callRemoteWithDefault_differentHook(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        TestPostDispatchHook testHook = new TestPostDispatchHook();
        InterchainAccountRouter router = deployIcaRouter(
            environment.mailboxes(origin),
            testHook,
            icaIsm,
            address(this)
        );

        // assert
        vm.expectCall(
            address(testHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );

        // act
        router.callRemote(
            destination,
            GAS_LIMIT_OVERRIDE,
            getCalls(data, value)
        );
    }

    function testFuzz_overrideAndCallRemote(
        bytes32 data,
        uint256 value
    ) public {
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, GAS_LIMIT_OVERRIDE);
    }

    function testFuzz_customMetadata_forIgp(
        uint64 gasLimit,
        uint64 overpayment,
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{
            value: gasLimit * igp.gasPrice() + overpayment
        }(destination, gasLimit, getCalls(data, value));

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

        // act
        vm.expectRevert("IGP: insufficient interchain gas payment");
        originIcaRouter.callRemote{value: payment}(
            destination,
            gasLimit,
            calls
        );
    }

    function testFuzz_callRemoteAdvanced_default(
        bytes32 data,
        uint256 value
    ) public {
        // arrange
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, GAS_LIMIT_OVERRIDE);
        assertEq(address(originIcaRouter.hook()), address(0));
    }

    function testFuzz_callRemoteAdvanced_metadata(
        uint64 gasLimit,
        bytes32 data,
        uint256 value
    ) public {
        uint256 balanceBefore = address(this).balance;

        // act
        originIcaRouter.callRemote{value: gasLimit * igp.gasPrice()}(
            destination,
            gasLimit,
            getCalls(data, value)
        );

        // assert
        uint256 balanceAfter = address(this).balance;
        assertRemoteCallReceived(data, value);
        assertIgpPayment(balanceBefore, balanceAfter, gasLimit);
    }

    function testFuzz_callRemoteAdvanced_withHook(
        bytes32 data,
        uint256 value
    ) public {
        TestPostDispatchHook testHook = new TestPostDispatchHook();

        vm.expectCall(
            address(testHook),
            0,
            abi.encodePacked(AbstractPostDispatchHook.postDispatch.selector)
        );
        originIcaRouter.callRemoteAdvanced(
            destination,
            routerOverride,
            ismOverride,
            bytes32(0),
            getCalls(data, value),
            testHook,
            new bytes(0)
        );
    }

    function testFuzz_callRemoteWithFailingIsmOverride(
        bytes32 data,
        uint256 value,
        bytes32 salt
    ) public {
        // arrange
        string memory failureMessage = "failing ism";
        bytes32 failingIsm = TypeCasts.addressToBytes32(
            address(new FailingIsm(failureMessage))
        );

        // act
        originIcaRouter.callRemoteAdvanced(
            destination,
            routerOverride,
            failingIsm,
            salt,
            getCalls(data, value),
            igp,
            StandardHookMetadata.overrideRefundAddress(address(this))
        );

        // assert
        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    function testFuzz_callRemoteWithFailingDefaultIsm(
        bytes32 data,
        uint256 value,
        bytes32 salt
    ) public {
        // arrange
        string memory failureMessage = "failing ism";
        FailingIsm failingIsm = new FailingIsm(failureMessage);

        // act
        environment.mailboxes(destination).setDefaultIsm(address(failingIsm));
        originIcaRouter.callRemoteAdvanced{value: gasPaymentQuote}(
            destination,
            routerOverride,
            bytes32(0), // ISM
            salt,
            getCalls(data, value),
            igp,
            StandardHookMetadata.overrideRefundAddress(address(this))
        );

        // assert
        vm.expectRevert(bytes(failureMessage));
        environment.processNextPendingMessage();
    }

    function testFuzz_receiveValue(uint256 value) public {
        vm.assume(value > 1 && value <= address(this).balance);
        // receive value before deployed
        assert(address(ica).code.length == 0);
        bool success;
        (success, ) = address(ica).call{value: value / 2}("");
        require(success, "transfer before deploy failed");

        // receive value after deployed
        destinationIcaRouter.getDeployedInterchainAccount(origin, config);
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

        originIcaRouter.callRemote{value: gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            calls
        );
        vm.expectCall(address(this), value, data);
        environment.processNextPendingMessage();
    }

    function testDifferentSalts(AccountConfig memory accountConfig) public {
        AccountConfig memory salted = AccountConfig({
            owner: accountConfig.owner,
            ism: accountConfig.ism,
            salt: ~accountConfig.salt
        });

        assertNotEq(
            address(
                destinationIcaRouter.getDeployedInterchainAccount(
                    origin,
                    salted
                )
            ),
            address(
                destinationIcaRouter.getDeployedInterchainAccount(
                    origin,
                    accountConfig
                )
            )
        );
    }

    function testFuzz_callRemoteCommitReveal(bytes32 commitment) public {
        // act
        originIcaRouter.callRemoteCommitReveal{value: 2 * gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            commitment
        );

        // Process message
        environment.processNextPendingMessage();

        // assert
        // Destination ICA router should have the commitment
        assertEq(
            address(destinationIcaRouter.verifiedCommitments(commitment)),
            address(ica)
        );
    }

    function testFuzz_revealAndExecute(
        bytes32 data,
        uint256 value,
        bytes32 salt
    ) public {
        // Arrange
        CallLib.Call[] memory calls = getCalls(data, value);
        bytes32 commitment = keccak256(abi.encode(salt, calls));
        deal(address(ica), value); // Ensure ICA has enough balance to execute calls

        // Act
        originIcaRouter.callRemoteCommitReveal{value: 2 * gasPaymentQuote}(
            destination,
            GAS_LIMIT_OVERRIDE,
            commitment
        );
        // Process commit message
        environment.processNextPendingMessage();

        // Destination ICA router should have the commitment after commit message
        assertEq(
            address(destinationIcaRouter.verifiedCommitments(commitment)),
            address(ica)
        );

        // Manually process the reveal. In reality, the CCIP read ISM will call `revealAndExecute`
        // but here we do it manually since we're not using the CCIP read ISM yet
        destinationIcaRouter.revealAndExecute(calls, salt);

        // Commitment should be cleared
        assertEq(
            address(destinationIcaRouter.verifiedCommitments(commitment)),
            address(0)
        );

        // Cannot reveal twice
        vm.expectRevert("Invalid Reveal");
        destinationIcaRouter.revealAndExecute(calls, salt);
    }
}
