// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HypTokenTest} from "./HypERC20.t.sol";
import {HypValue} from "../../contracts/token/HypValue.sol";
import {OPL2ToL1Hook} from "../../contracts/hooks/OPL2ToL1Hook.sol";
import {OPL2ToL1Ism} from "../../contracts/isms/hook/OPL2ToL1Ism.sol";
import {MockOptimismMessenger, MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";

contract HypValueTest is HypTokenTest {
    using TypeCasts for address;

    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    HypValue internal valueRouter;
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

        localToken = new HypValue(address(localMailbox));
        valueRouter = HypValue(payable(address(localToken)));

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

        valueRouter.initialize(address(valueHook), address(ism), address(this));

        valueRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );

        vm.deal(ALICE, 1000e18);
    }

    function testRemoteTransfer() public {
        // uint256 balanceBefore = localToken.balanceOf(ALICE);

        uint256 quote = valueRouter.quoteGasPayment(DESTINATION);
        uint256 msgValue = TRANSFER_AMT + quote;

        // vm.prank(ALICE);
        _performRemoteTransferWithEmit(msgValue, TRANSFER_AMT, quote);
        // assertEq(localToken.balanceOf(ALICE), balanceBefore - TRANSFER_AMT);
    }

    function testTransfer_withHookSpecified(
        uint256 fee,
        bytes calldata metadata
    ) public override {}
}
