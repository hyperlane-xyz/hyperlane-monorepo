// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HypTokenTest} from "./HypERC20.t.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {HypValue} from "../../contracts/token/HypValue.sol";
import {OPL2ToL1Hook} from "../../contracts/hooks/OPL2ToL1Hook.sol";
import {OPL2ToL1Ism} from "../../contracts/isms/hook/OPL2ToL1Ism.sol";
import {IOptimismPortal} from "../../contracts/interfaces/optimism/IOptimismPortal.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {ICrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {MockOptimismMessenger, MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";

contract HypValueTest is HypTokenTest {
    using TypeCasts for address;

    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;
    uint256 internal constant OP_BRIDGE_GAS_LIMIT = 100_000;
    uint256 internal constant MOCK_NONCE = 0;

    HypValue internal localValueRouter;
    HypValue internal remoteValueRouter;
    OPL2ToL1Hook internal valueHook;
    OPL2ToL1Ism internal ism;
    TestInterchainGasPaymaster internal mockOverheadIgp;
    MockOptimismPortal internal portal;
    MockOptimismMessenger internal l1Messenger;

    function setUp() public override {
        super.setUp();
        vm.etch(
            L2_MESSENGER_ADDRESS,
            address(new MockOptimismMessenger()).code
        );

        localValueRouter = new HypValue(address(localMailbox));
        remoteValueRouter = new HypValue(address(remoteMailbox));

        localToken = TokenRouter(payable(address(localValueRouter)));
        remoteToken = HypERC20(payable(address(remoteValueRouter)));

        l1Messenger = new MockOptimismMessenger();
        portal = new MockOptimismPortal();
        l1Messenger.setPORTAL(address(portal));
        ism = new OPL2ToL1Ism(address(l1Messenger));

        mockOverheadIgp = new TestInterchainGasPaymaster();
        valueHook = new OPL2ToL1Hook(
            address(localMailbox),
            DESTINATION,
            address(localMailbox).addressToBytes32(),
            L2_MESSENGER_ADDRESS,
            address(mockOverheadIgp)
        );

        localValueRouter.initialize(
            address(valueHook),
            address(ism),
            address(this)
        );
        remoteValueRouter.initialize(
            address(valueHook),
            address(ism),
            address(this)
        );

        localValueRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteValueRouter.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );

        vm.deal(ALICE, TRANSFER_AMT * 10);
    }

    function testRemoteTransfer() public {
        uint256 quote = localValueRouter.quoteGasPayment(DESTINATION);
        uint256 msgValue = TRANSFER_AMT + quote;

        vm.expectEmit(true, true, false, true);
        emit TokenRouter.SentTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.assertEq(address(localToken).balance, 0);
        vm.assertEq(address(valueHook).balance, 0);

        _externalBridgeDestinationCall(messageId, msgValue);

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        remoteMailbox.processNextInboundMessage();

        assertEq(BOB.balance, TRANSFER_AMT);
        assertEq(address(mockOverheadIgp).balance, quote);
    }

    function testRemoteTransfer_invalidAmount() public {
        uint256 quote = localValueRouter.quoteGasPayment(DESTINATION);

        vm.expectRevert(
            abi.encodeWithSelector(
                HypValue.InsufficientValue.selector,
                TRANSFER_AMT + quote,
                TRANSFER_AMT
            )
        );
        vm.prank(ALICE);
        localToken.transferRemote{value: TRANSFER_AMT}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function testTransfer_withHookSpecified(
        uint256 fee,
        bytes calldata metadata
    ) public override {
        vm.assume(fee < TRANSFER_AMT);
        uint256 msgValue = TRANSFER_AMT + fee;
        vm.deal(ALICE, msgValue);

        TestPostDispatchHook hook = new TestPostDispatchHook();
        hook.setFee(fee);

        vm.prank(ALICE);
        localToken.transferRemote{value: msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            metadata,
            address(hook)
        );

        vm.assertEq(address(localToken).balance, 0);
        vm.assertEq(address(valueHook).balance, 0);
    }

    function testTransfer_withHookSpecified_revertsInsufficientValue(
        uint256 fee,
        bytes calldata metadata
    ) public {
        vm.assume(fee < TRANSFER_AMT);
        uint256 msgValue = TRANSFER_AMT + fee;
        vm.deal(ALICE, msgValue);

        TestPostDispatchHook hook = new TestPostDispatchHook();
        hook.setFee(fee);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                HypValue.InsufficientValue.selector,
                msgValue,
                msgValue - 1
            )
        );
        localToken.transferRemote{value: msgValue - 1}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            metadata,
            address(hook)
        );
    }

    function testBenchmark_overheadGasUsage() public override {
        vm.deal(address(localValueRouter), TRANSFER_AMT);
        super.testBenchmark_overheadGasUsage();
    }

    // helper function to simulate the external bridge destination call using OP L2 -> L1 bridge
    function _externalBridgeDestinationCall(
        bytes32 _messageId,
        uint256 _msgValue
    ) internal {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (_messageId, _msgValue)
        );

        bytes memory messengerCalldata = abi.encodeCall(
            ICrossDomainMessenger.relayMessage,
            (
                MOCK_NONCE,
                address(valueHook),
                address(ism),
                _msgValue,
                OP_BRIDGE_GAS_LIMIT,
                encodedHookData
            )
        );
        vm.deal(address(portal), _msgValue);
        IOptimismPortal.WithdrawalTransaction
            memory withdrawal = IOptimismPortal.WithdrawalTransaction({
                nonce: MOCK_NONCE,
                sender: L2_MESSENGER_ADDRESS,
                target: address(l1Messenger),
                value: _msgValue,
                gasLimit: OP_BRIDGE_GAS_LIMIT,
                data: messengerCalldata
            });
        portal.finalizeWithdrawalTransaction(withdrawal);
    }
}
