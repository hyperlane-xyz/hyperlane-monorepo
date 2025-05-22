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
import {OpL2NativeTokenBridge, OpL1V1NativeTokenBridge} from "../../contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {OPL2ToL1Withdrawal} from "../../contracts/libs/OPL2ToL1Withdrawal.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {MockOptimismMessenger, MockOptimismStandardBridge, MockL2ToL1MessagePasser} from "../../contracts/mock/MockOptimism.sol";
import {IInterchainGasPaymaster} from "../../contracts/interfaces/IInterchainGasPaymaster.sol";
import {StaticAggregationHook} from "../../contracts/hooks/aggregation/StaticAggregationHook.sol";
import {StaticAggregationHookFactory} from "../../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";

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
    OpL2NativeTokenBridge internal vtbOrigin;
    OpL1V1NativeTokenBridge internal vtbDestination;

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

        deployTokenBridges();

        vm.deal(user, userBalance);
    }

    function deployTokenBridges() public {
        OpL2NativeTokenBridge l2implementation = new OpL2NativeTokenBridge(
            address(environment.mailboxes(origin)),
            L2_BRIDGE_ADDRESS
        );

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(l2implementation),
            ADMIN,
            abi.encodeWithSelector(
                HypNative.initialize.selector,
                address(hook),
                address(ism),
                address(this) // owner
            )
        );

        vtbOrigin = OpL2NativeTokenBridge(payable(proxy));

        OpL1V1NativeTokenBridge l1implementation = new OpL1V1NativeTokenBridge(
            address(environment.mailboxes(destination)),
            address(0),
            new string[](0)
        );

        proxy = new TransparentUpgradeableProxy(
            address(l1implementation),
            ADMIN,
            abi.encodeWithSelector(
                HypNative.initialize.selector,
                address(0),
                address(ism),
                address(this)
            )
        );

        vtbDestination = OpL1V1NativeTokenBridge(payable(proxy));

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

    function test_transferRemote_amountMustBeGreaterThanZero() public {
        vm.expectRevert("OP L2 token bridge: amount must be greater than 0");
        vtbOrigin.transferRemote(destination, userB32, 0);
    }

    function test_transferRemote_fundsReceived() public {
        Quote[] memory quotes = _getQuote();

        vtbOrigin.transferRemote{value: quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        vm.mockCall(
            address(vtbDestination),
            abi.encode(vtbDestination.verify.selector),
            abi.encode(true)
        );

        // prove amount
        vm.expectEmit(false, true, true, true, address(vtbDestination));
        emit TokenRouter.ReceivedTransferRemote(origin, userB32, 0);
        environment.processNextPendingMessage();

        // withdraw amount
        vm.expectEmit(false, true, true, true, address(vtbDestination));
        emit TokenRouter.ReceivedTransferRemote(
            origin,
            userB32,
            transferAmount
        );
        environment.processNextPendingMessage();
    }

    receive() external payable {}

    function test_transferRemote_refunds() public {
        Quote[] memory quotes = _getQuote();

        uint256 balanceBefore = address(this).balance;

        vtbOrigin.transferRemote{value: 2 * quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        uint256 balanceAfter = address(this).balance;

        assertEq(balanceBefore - balanceAfter, quotes[0].amount);
    }

    function test_interchainSecurityModule_returnsConfiguredIsm() public {
        assertEq(
            address(vtbDestination.interchainSecurityModule()),
            address(vtbDestination),
            "vtbDestination should be the configured ISM"
        );
    }

    function test_OpL1_transferRemote_revertsAsExpected() public {
        vm.expectRevert(bytes("OP L1 token bridge should not send messages"));
        // Call transferRemote with dummy values as it should revert before using them.
        vtbDestination.transferRemote(origin, userB32, transferAmount);
    }

    function test_OpL2_handle_revertsAsExpected() public {
        vm.expectRevert(
            bytes("OP L2 token bridge should not receive messages")
        );
        // Call handle with dummy values as it should revert before using them.
        vtbOrigin.handle(destination, userB32, bytes(""));
    }

    function test_OpL2_transferRemote_revertsIfRefundAddressIsZero() public {
        // 1. Craft metadata that specifies address(0) for refunds.
        // The msgValue and gasLimit here are for the StandardHookMetadata format,
        // but their specific values don't affect the refund address retrieval part we're testing.
        bytes memory zeroRefundMetadata = StandardHookMetadata.format(
            0, // msgValue for hook
            0, // gasLimit for hook
            address(0) // explicit zero refund address
        );

        // 2. Determine the value needed for the transfer operation itself.
        // This quote includes the amount to bridge and the gas for two internal messages.
        uint256 internalOpsValue = vtbOrigin
        .quoteTransferRemote(destination, userB32, transferAmount)[0].amount;

        // 3. Send a bit more than required, so there's something left to refund.
        uint256 valueToSend = internalOpsValue + 1 wei; // 1 wei to be refunded

        // 4. Expect a revert from the explicit check in OpL2NativeTokenBridge.
        vm.expectRevert(bytes("OP L2 token bridge: refund address is 0"));

        // 5. Call the transferRemote function that accepts custom metadata.
        vtbOrigin.transferRemote{value: valueToSend}(
            destination,
            userB32,
            transferAmount,
            zeroRefundMetadata, // Our crafted metadata with address(0) as refund target
            address(igp) // Use the standard IGP for gas payments
        );
    }
}
