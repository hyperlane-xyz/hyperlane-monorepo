// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {TestCcipReadIsm} from "../../contracts/test/TestCcipReadIsm.sol";
import {OPL2ToL1TokenBridgeNative} from "../../contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol";

import {OPL2ToL1CcipReadHook} from "../../contracts/hooks/OPL2ToL1CcipReadHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {OPL2ToL1Withdrawal} from "../../contracts/libs/OPL2ToL1Withdrawal.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {MockOptimismMessenger, MockOptimismStandardBridge, MockL2ToL1MessagePasser} from "../../contracts/mock/MockOptimism.sol";
import {IInterchainGasPaymaster} from "../../contracts/interfaces/IInterchainGasPaymaster.sol";
import {StaticAggregationHook} from "../../contracts/hooks/aggregation/StaticAggregationHook.sol";
import {StaticAggregationHookFactory} from "../../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";

contract OPL2ToL1TokenBridgeNativeTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;

    uint32 internal constant SCALE = 1;

    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;
    address payable internal constant L2_BRIDGE_ADDRESS =
        payable(0x4200000000000000000000000000000000000010);
    address payable internal constant L2_MESSAGE_PASSER =
        payable(0x4200000000000000000000000000000000000016);

    address internal constant ADMIN = address(0x9);

    TestCcipReadIsm internal ism;
    TestInterchainGasPaymaster internal igp;
    StaticAggregationHook internal hook;
    OPL2ToL1TokenBridgeNative internal vtbOrigin;
    OPL2ToL1TokenBridgeNative internal vtbDestination;
    OPL2ToL1CcipReadHook internal ccipReadHook;

    MockHyperlaneEnvironment internal environment;
    MockOptimismStandardBridge internal bridge;

    uint256 internal transferAmount = 0.001 ether;
    address internal user = address(11);
    uint256 internal userBalance = 1 ether;
    bytes32 internal userB32 = user.addressToBytes32();
    Quote[] internal quotes;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(origin, destination);

        igp = new TestInterchainGasPaymaster();
        environment.mailboxes(origin).setDefaultHook(address(igp));

        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );

        vm.etch(
            L2_BRIDGE_ADDRESS,
            address(new MockOptimismStandardBridge()).code
        );

        vm.etch(L2_MESSAGE_PASSER, address(new MockL2ToL1MessagePasser()).code);

        deployAll();

        vm.deal(user, userBalance);
    }

    function deployHooks() public {
        ccipReadHook = new OPL2ToL1CcipReadHook(
            environment.mailboxes(origin),
            address(ism),
            IPostDispatchHook(address(0))
        );

        StaticAggregationHookFactory factory = new StaticAggregationHookFactory();
        address[] memory hooks = new address[](2);
        // We need the IGP in order to pay relay fees for the first message
        hooks[0] = address(ccipReadHook);
        hooks[1] = address(igp);

        hook = StaticAggregationHook(factory.deploy(hooks));
    }

    function deployIsm() public {
        ism = new TestCcipReadIsm(address(environment.mailboxes(destination)));
    }

    function deployAll() public {
        deployIsm();
        deployHooks();
        deployTokenBridges();
    }

    function deployTokenBridges() public {
        OPL2ToL1TokenBridgeNative implementation = new OPL2ToL1TokenBridgeNative(
                SCALE,
                address(environment.mailboxes(origin)),
                destination,
                L2_BRIDGE_ADDRESS
            );

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            ADMIN,
            abi.encodeWithSelector(
                HypNative.initialize.selector,
                address(hook),
                address(ism),
                address(this) // owner
            )
        );

        vtbOrigin = OPL2ToL1TokenBridgeNative(payable(proxy));

        implementation = new OPL2ToL1TokenBridgeNative(
            SCALE,
            address(environment.mailboxes(destination)),
            destination,
            address(0)
        );

        proxy = new TransparentUpgradeableProxy(
            address(implementation),
            ADMIN,
            abi.encodeWithSelector(
                HypNative.initialize.selector,
                address(0),
                address(ism),
                address(this)
            )
        );

        vtbDestination = OPL2ToL1TokenBridgeNative(payable(proxy));

        vtbOrigin.enrollRemoteRouter(
            destination,
            address(vtbDestination).addressToBytes32()
        );

        vtbDestination.enrollRemoteRouter(
            origin,
            address(vtbOrigin).addressToBytes32()
        );
    }

    function _expectGasPayment(uint256 gasLimit) private {
        bytes32 messageId = bytes32(0);
        uint256 payment = igp.quoteGasPayment(0, gasLimit);

        vm.expectEmit(false, true, true, true, address(igp));
        emit IInterchainGasPaymaster.GasPayment(
            messageId,
            destination,
            gasLimit,
            payment
        );
    }

    function _getQuote() private returns (Quote[] memory) {
        return
            vtbOrigin.quoteTransferRemote(destination, userB32, transferAmount);
    }

    function _getMsgValue() private returns (uint256) {
        Quote[] memory quotes = _getQuote();

        return transferAmount + quotes[0].amount;
    }

    function test_constructor() public {
        assertEq(address(vtbOrigin.hook()), address(hook));
    }

    function test_transferRemote_expectReceivedMessageEvent() public {
        Quote[] memory quotes = _getQuote();

        vm.prank(user);
        vtbOrigin.transferRemote{value: transferAmount + quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        vm.expectEmit(true, true, false, false, address(ism));
        emit TestCcipReadIsm.ReceivedMessage(
            origin,
            address(ccipReadHook).addressToBytes32(),
            0,
            bytes("")
        );

        environment.processNextPendingMessage();
    }

    function test_transferRemote_fundsReceived() public {
        Quote[] memory quotes = _getQuote();
        vm.prank(user);
        vtbOrigin.transferRemote{value: transferAmount + quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        environment.processNextPendingMessage();

        // After the withdrawal is finalized, the destination
        // value transfer bridge has received the amount
        vm.deal(address(vtbDestination), transferAmount);

        environment.processNextPendingMessage();

        // Recipient was the user account
        assertEq(user.balance, userBalance - quotes[0].amount);
    }
}
