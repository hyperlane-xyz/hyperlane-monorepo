// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {TestCcipReadIsm} from "../../contracts/test/TestCcipReadIsm.sol";
import {OPValueTransferBridgeNative} from "../../contracts/token/extensions/OPValueTransferBridgeNative.sol";

import {OPL2ToL1CcipReadHook} from "../../contracts/hooks/OPL2ToL1CcipReadHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {OPL2ToL1Withdrawal} from "../../contracts/libs/OPL2ToL1Withdrawal.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {Quotes} from "../../contracts/interfaces/IValueTransferBridge.sol";
import {MockOptimismMessenger, MockOptimismStandardBridge, MockL2ToL1MessagePasser} from "../../contracts/mock/MockOptimism.sol";
import {IInterchainGasPaymaster} from "../../contracts/interfaces/IInterchainGasPaymaster.sol";
import {StaticAggregationHook} from "../../contracts/hooks/aggregation/StaticAggregationHook.sol";
import {StaticAggregationHookFactory} from "../../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";

import {console} from "forge-std/console.sol";

// Needed to access the withdrawal hash
contract OPValueTransferBridgeNativeTest is OPValueTransferBridgeNative {
    using TypeCasts for bytes32;

    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) OPValueTransferBridgeNative(_l1Domain, _l2Bridge, _mailbox) {}

    function getWithdrawalMetadata(
        uint256 _amountOrId
    ) public view returns (bytes memory) {
        address remoteRouter = _mustHaveRemoteRouter(l1Domain)
            .bytes32ToAddress();
        bytes memory extraData = bytes("");

        return
            OPL2ToL1Withdrawal.getWithdrawalMetadata(
                payable(l2Bridge),
                address(OP_MESSAGE_PASSER),
                OP_MIN_GAS_LIMIT_ON_L1,
                remoteRouter,
                _amountOrId,
                extraData
            );
    }
}

contract ValueTransferBridgeNativeTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;

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
    OPValueTransferBridgeNativeTest internal vtbOrigin;
    OPValueTransferBridgeNativeTest internal vtbDestination;
    OPL2ToL1CcipReadHook internal ccipReadHook;

    MockHyperlaneEnvironment internal environment;
    MockOptimismStandardBridge internal bridge;

    uint256 internal transferAmount = 0.001 ether;
    address internal user = address(11);
    uint256 internal userBalance = 1 ether;
    bytes32 internal userB32 = user.addressToBytes32();
    Quotes[] internal quotes;

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
            address(environment.mailboxes(origin)),
            address(ism),
            address(0)
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
        deployValueTransferBridges();
    }

    function deployValueTransferBridges() public {
        OPValueTransferBridgeNativeTest implementation = new OPValueTransferBridgeNativeTest(
                destination,
                L2_BRIDGE_ADDRESS,
                address(environment.mailboxes(origin))
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

        vtbOrigin = OPValueTransferBridgeNativeTest(payable(proxy));

        implementation = new OPValueTransferBridgeNativeTest(
            destination,
            address(0),
            address(environment.mailboxes(destination))
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

        vtbDestination = OPValueTransferBridgeNativeTest(payable(proxy));

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

    function _getQuotes() private returns (Quotes[] memory) {
        return
            vtbOrigin.quoteTransferRemote(destination, userB32, transferAmount);
    }

    function _getMsgValue() private returns (uint256) {
        Quotes[] memory quotes = _getQuotes();

        return transferAmount + quotes[0].amount;
    }

    function test_constructor() public {
        assertEq(address(vtbOrigin.hook()), address(hook));
    }

    function test_transferRemote_expectTwoGasPayments() public {
        Quotes[] memory quotes = _getQuotes();

        // Expects two gas payments
        _expectGasPayment(ccipReadHook.PROVE_WITHDRAWAL_GAS_LIMIT());
        _expectGasPayment(vtbOrigin.FINALIZE_WITHDRAWAL_GAS_LIMIT());

        vm.prank(user);
        vtbOrigin.transferRemote{value: transferAmount + quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        environment.processNextPendingMessage();
    }

    function test_transferRemote_expectReceivedMessageEvent() public {
        Quotes[] memory quotes = _getQuotes();

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
        Quotes[] memory quotes = _getQuotes();
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

    function test_transferRemote_hookMessageBodyIsCorrect() public {
        bytes32 expectedWithdrawalHash = abi.decode(
            vtbOrigin.getWithdrawalMetadata(transferAmount),
            (bytes32)
        );

        Quotes[] memory quotes = _getQuotes();
        vm.prank(user);
        vtbOrigin.transferRemote{value: transferAmount + quotes[0].amount}(
            destination,
            userB32,
            transferAmount
        );

        uint32 inboundNonce = environment
            .mailboxes(destination)
            .inboundProcessedNonce();

        bytes memory hookMessage = environment
            .mailboxes(destination)
            .inboundMessages(inboundNonce);

        bytes memory vtbMessage = environment
            .mailboxes(destination)
            .inboundMessages(inboundNonce + 1);

        bytes32 withdrawalHash = abi.decode(
            _getMessageBody(hookMessage),
            (bytes32)
        );

        assertEq(withdrawalHash, expectedWithdrawalHash);
    }

    function _getMessageBody(
        bytes memory message
    ) private pure returns (bytes memory) {
        return _sliceBytes(message, 77);
    }

    function _getTokenMessageMetadata(
        bytes memory message
    ) private pure returns (bytes memory) {
        return _sliceBytes(message, 64);
    }

    function _sliceBytes(
        bytes memory data,
        uint256 offset
    ) private pure returns (bytes memory) {
        require(offset < data.length, "Offset out of bounds");

        uint256 length = data.length - offset;
        bytes memory result = new bytes(length);

        assembly {
            let resultPtr := add(result, 0x20)
            let dataPtr := add(add(data, 0x20), offset)
            for {
                let i := 0
            } lt(i, length) {
                i := add(i, 0x20)
            } {
                mstore(add(resultPtr, i), mload(add(dataPtr, i)))
            }
        }

        return result;
    }
}
