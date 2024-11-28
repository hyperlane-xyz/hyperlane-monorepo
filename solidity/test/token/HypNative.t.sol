// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HypTokenTest} from "./HypERC20.t.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";

contract HypNativeTest is HypTokenTest {
    using TypeCasts for address;

    HypNative internal localValueRouter;
    HypNative internal remoteValueRouter;
    TestPostDispatchHook internal valueHook;
    TestIsm internal ism;

    function setUp() public override {
        super.setUp();

        localValueRouter = new HypNative(address(localMailbox));
        remoteValueRouter = new HypNative(address(remoteMailbox));

        localToken = TokenRouter(payable(address(localValueRouter)));
        remoteToken = HypERC20(payable(address(remoteValueRouter)));

        ism = new TestIsm();

        valueHook = new TestPostDispatchHook();
        valueHook.setFee(1e10);

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
        localToken.transferRemote{value: msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.assertEq(address(localToken).balance, 0);
        vm.assertEq(address(valueHook).balance, msgValue);

        vm.deal(address(remoteToken), TRANSFER_AMT);
        vm.prank(address(remoteMailbox));

        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), TRANSFER_AMT)
        );

        assertEq(BOB.balance, TRANSFER_AMT);
        assertEq(address(valueHook).balance, msgValue);
    }

    function testRemoteTransfer_invalidAmount() public {
        uint256 quote = localValueRouter.quoteGasPayment(DESTINATION);

        vm.expectRevert("HypNative: insufficient value");
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
        vm.expectRevert("HypNative: insufficient value");
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
}
