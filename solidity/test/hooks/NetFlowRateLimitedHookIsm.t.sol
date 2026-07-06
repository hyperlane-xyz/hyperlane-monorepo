// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {HypERC20} from "contracts/token/HypERC20.sol";
import {HypNative} from "contracts/token/HypNative.sol";
import {HypERC4626Collateral} from "contracts/token/extensions/HypERC4626Collateral.sol";
import {ERC4626Test} from "contracts/test/ERC4626/ERC4626Test.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {NetFlowRateLimitedHookIsm} from "contracts/hooks/warp-route/NetFlowRateLimitedHookIsm.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {TvlRateLimited} from "contracts/libs/TvlRateLimited.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

contract NetFlowRateLimitedHookIsmTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant INITIAL_COLLATERAL = 100 ether;
    uint256 constant MAX_FLOW_BPS = 1_000; // 10%
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    address constant BOB = address(0x2);

    TestMailbox localMailbox;
    TestMailbox remoteMailbox;
    ERC20Test token;
    TestPostDispatchHook noopHook;

    HypERC20Collateral localRouter;
    HypERC20Collateral remoteRouter;
    NetFlowRateLimitedHookIsm netFlow;

    function setUp() external {
        localMailbox = new TestMailbox(DESTINATION);
        remoteMailbox = new TestMailbox(ORIGIN);

        token = new ERC20Test("Test", "Test", 1_000 ether, DECIMALS);
        noopHook = new TestPostDispatchHook();

        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        localRouter = new HypERC20Collateral(
            address(token),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        remoteRouter = new HypERC20Collateral(
            address(token),
            SCALE,
            SCALE,
            address(remoteMailbox)
        );

        netFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            MAX_FLOW_BPS
        );

        localRouter.initialize(
            address(netFlow),
            address(netFlow),
            address(this)
        );
        remoteRouter.initialize(address(noopHook), address(0), address(this));

        localRouter.enrollRemoteRouter(
            ORIGIN,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            DESTINATION,
            address(localRouter).addressToBytes32()
        );

        token.mintTo(address(localRouter), INITIAL_COLLATERAL);
    }

    function test_initialCapacity_isTvlBps() external view {
        assertEq(netFlow.capacityToken(), address(token));
        assertEq(
            uint8(netFlow.outboundFlow()),
            uint8(NetFlowRateLimitedHookIsm.FlowDirection.CREDIT)
        );
        assertEq(netFlow.localCollateral(), INITIAL_COLLATERAL);
        assertEq(netFlow.maxCapacity(), 10 ether);
        assertEq(netFlow.calculateCurrentLevel(), 10 ether);
    }

    function test_reportsTypesAndZeroQuote() external view {
        assertEq(
            netFlow.hookType(),
            uint8(IPostDispatchHook.HookTypes.RATE_LIMITED)
        );
        assertEq(
            netFlow.moduleType(),
            uint8(IInterchainSecurityModule.Types.NULL)
        );
        assertEq(netFlow.quoteDispatch(bytes(""), bytes("")), 0);
    }

    function test_inboundConsumesLocalNetFlow() external {
        _processInbound(9 ether);

        assertEq(token.balanceOf(BOB), 9 ether);
        assertEq(token.balanceOf(address(localRouter)), 91 ether);
        assertEq(netFlow.calculateCurrentLevel(), 1 ether);
    }

    function test_inboundRevertsIfNetOutflowExceedsTvlBps() external {
        bytes memory message = _inboundMessage(11 ether);

        vm.expectRevert("RateLimitExceeded");
        localMailbox.process(bytes(""), message);
    }

    function test_verifyRevertsIfInvalidRecipient() external {
        bytes memory message = localMailbox.buildInboundMessage(
            ORIGIN,
            address(0xdead).addressToBytes32(),
            address(remoteRouter).addressToBytes32(),
            TokenMessage.format(BOB.addressToBytes32(), 1 ether, bytes(""))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.WrongRecipient.selector,
                address(0xdead)
            )
        );
        netFlow.verify(bytes(""), message);
    }

    function test_verifyRevertsIfMessageNotDelivered() external {
        bytes memory message = _inboundMessage(1 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.InvalidDeliveredMessage.selector,
                message.id()
            )
        );
        netFlow.verify(bytes(""), message);
    }

    function test_outboundCreditsLocalNetFlow() external {
        _processInbound(9 ether);
        assertEq(netFlow.calculateCurrentLevel(), 1 ether);

        token.approve(address(localRouter), 5 ether);
        localRouter.transferRemote(ORIGIN, BOB.addressToBytes32(), 5 ether);

        assertEq(token.balanceOf(address(localRouter)), 96 ether);
        assertEq(netFlow.calculateCurrentLevel(), 6 ether);

        _processInbound(6 ether);
        assertEq(token.balanceOf(BOB), 15 ether);
    }

    function test_refillsOverTimeAgainstCurrentTvl() external {
        _processInbound(10 ether);
        assertEq(netFlow.calculateCurrentLevel(), 0);

        vm.warp(block.timestamp + 12 hours);

        assertEq(token.balanceOf(address(localRouter)), 90 ether);
        assertEq(netFlow.maxCapacity(), 9 ether);
        assertEq(netFlow.calculateCurrentLevel(), 4.5 ether);
    }

    function test_preventsDuplicateInboundValidation() external {
        bytes memory message = _inboundMessage(1 ether);

        localMailbox.process(bytes(""), message);

        vm.expectRevert("Mailbox: already delivered");
        localMailbox.process(bytes(""), message);

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.MessageAlreadyValidated.selector,
                message.id()
            )
        );
        netFlow.verify(bytes(""), message);
    }

    function test_revertsDeliveredMessageFromBeforeDeployment() external {
        bytes memory message = _inboundMessage(1 ether);
        localMailbox.process(bytes(""), message);

        vm.roll(block.number + 1);
        NetFlowRateLimitedHookIsm newNetFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            MAX_FLOW_BPS
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.InvalidDeliveredMessage.selector,
                message.id()
            )
        );
        newNetFlow.verify(bytes(""), message);
    }

    function test_preventsDuplicateOutboundCredit() external {
        bytes memory message = _outboundMessage(5 ether);

        token.approve(address(localRouter), 5 ether);
        localRouter.transferRemote(ORIGIN, BOB.addressToBytes32(), 5 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.MessageAlreadyValidated.selector,
                message.id()
            )
        );
        netFlow.postDispatch(bytes(""), message);
    }

    function test_revertsLatestDispatchedMessageFromBeforeDeployment()
        external
    {
        bytes memory message = _outboundMessage(5 ether);

        token.approve(address(localRouter), 5 ether);
        localRouter.transferRemote(ORIGIN, BOB.addressToBytes32(), 5 ether);

        NetFlowRateLimitedHookIsm newNetFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            MAX_FLOW_BPS
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.InvalidDispatchedMessage.selector,
                message.id()
            )
        );
        newNetFlow.postDispatch(bytes(""), message);
    }

    function test_revertsFakeOutboundCredit() external {
        bytes memory message = _outboundMessage(5 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.InvalidDispatchedMessage.selector,
                message.id()
            )
        );
        netFlow.postDispatch(bytes(""), message);
    }

    function test_postDispatchRevertsIfInvalidSender() external {
        bytes memory message = localMailbox.buildOutboundMessage(
            ORIGIN,
            address(remoteRouter).addressToBytes32(),
            TokenMessage.format(BOB.addressToBytes32(), 5 ether, bytes(""))
        );

        localMailbox.updateLatestDispatchedId(message.id());

        vm.expectRevert(
            abi.encodeWithSelector(
                NetFlowRateLimitedHookIsm.WrongSender.selector,
                address(this)
            )
        );
        netFlow.postDispatch(bytes(""), message);
    }

    function test_constructorRevertsIfRouterIsZero() external {
        vm.expectRevert(TvlRateLimited.InvalidRouter.selector);
        new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(0),
            MAX_FLOW_BPS
        );
    }

    function test_constructorRevertsIfMaxFlowBpsTooHigh() external {
        vm.expectRevert(TvlRateLimited.InvalidThresholdBps.selector);
        new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            10_001
        );
    }

    // Reject-mode: a 100% threshold is rejected (strict), unlike the delay-mode
    // DelayedFlowRouter which permits it.
    function test_constructorRevertsIfMaxFlowBpsIs100Percent() external {
        vm.expectRevert(TvlRateLimited.InvalidThresholdBps.selector);
        new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            10_000
        );
    }

    /// @dev Documents the composition requirement (contract docstring): as a
    /// route's SOLE ISM, NetFlow authenticates flow only (moduleType NULL), so
    /// any caller can process a forged inbound message to an arbitrary
    /// recipient, bounded only by the bucket capacity. Deployers MUST compose
    /// it under an authenticating ISM.
    function test_soleIsm_forgedMessageIsNotAuthenticated() external {
        address attacker = address(0xBEEF);
        address forgedRecipient = address(0xCAFE);

        // No real cross-chain transfer happened; the attacker fabricates a
        // message whose sender is the enrolled remote router.
        bytes memory forged = localMailbox.buildInboundMessage(
            ORIGIN,
            address(localRouter).addressToBytes32(),
            address(remoteRouter).addressToBytes32(),
            TokenMessage.format(
                forgedRecipient.addressToBytes32(),
                10 ether, // == capacity (10% of 100 ether TVL)
                bytes("")
            )
        );

        vm.prank(attacker);
        localMailbox.process(bytes(""), forged);

        // Delivered purely on capacity: NetFlow never checked authenticity.
        assertEq(token.balanceOf(forgedRecipient), 10 ether);
    }

    /// @dev Deploys a real vault-backed collateral route to confirm the
    /// HypERC4626Collateral exclusion: assets are deposited into the vault, so
    /// the router holds shares while `token().balanceOf(router)` stays 0 —
    /// capacity (and thus the limiter) collapses to zero despite real TVL.
    function test_hypERC4626Collateral_capacityCollapses() external {
        ERC4626Test vault = new ERC4626Test(address(token), "Vault", "V");
        HypERC4626Collateral vaultRouter = new HypERC4626Collateral(
            ERC4626(address(vault)),
            SCALE,
            SCALE,
            address(localMailbox)
        );

        // Fund the router with real TVL, held as vault shares.
        token.approve(address(vault), 100 ether);
        vault.deposit(100 ether, address(vaultRouter));
        assertGt(vault.balanceOf(address(vaultRouter)), 0);

        NetFlowRateLimitedHookIsm vaultNetFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(vaultRouter),
            MAX_FLOW_BPS
        );

        // token() is the vault asset, held at 0 by the router (it's in the
        // vault as shares), so capacity collapses to zero.
        assertEq(vaultRouter.token(), address(token));
        assertEq(token.balanceOf(address(vaultRouter)), 0);
        assertEq(vaultNetFlow.localCollateral(), 0);
        assertEq(vaultNetFlow.maxCapacity(), 0);
    }

    function _processInbound(uint256 amount) internal {
        localMailbox.process(bytes(""), _inboundMessage(amount));
    }

    function _inboundMessage(
        uint256 amount
    ) internal view returns (bytes memory) {
        return
            localMailbox.buildInboundMessage(
                ORIGIN,
                address(localRouter).addressToBytes32(),
                address(remoteRouter).addressToBytes32(),
                TokenMessage.format(BOB.addressToBytes32(), amount, bytes(""))
            );
    }

    function _outboundMessage(uint256 amount) internal returns (bytes memory) {
        vm.prank(address(localRouter));
        return
            localMailbox.buildOutboundMessage(
                ORIGIN,
                address(remoteRouter).addressToBytes32(),
                TokenMessage.format(BOB.addressToBytes32(), amount, bytes(""))
            );
    }
}

contract NetFlowRateLimitedHookIsmSyntheticTest is Test {
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant MAX_FLOW_BPS = 1_000; // 10%
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    address constant BOB = address(0x2);

    TestMailbox localMailbox;
    TestMailbox remoteMailbox;
    TestPostDispatchHook noopHook;
    HypERC20 localRouter;
    HypERC20 remoteRouter;
    NetFlowRateLimitedHookIsm netFlow;

    function setUp() external {
        localMailbox = new TestMailbox(ORIGIN);
        remoteMailbox = new TestMailbox(DESTINATION);
        noopHook = new TestPostDispatchHook();

        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        localRouter = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(localMailbox)
        );
        remoteRouter = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(remoteMailbox)
        );

        netFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            MAX_FLOW_BPS
        );

        localRouter.initialize(
            100 ether,
            "Test",
            "TEST",
            address(netFlow),
            address(netFlow),
            address(this)
        );
        remoteRouter.initialize(
            0,
            "Test",
            "TEST",
            address(noopHook),
            address(0),
            address(this)
        );

        localRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            ORIGIN,
            address(localRouter).addressToBytes32()
        );
    }

    function test_syntheticInitialCapacity_isSupplyBps() external view {
        assertEq(netFlow.capacityToken(), address(localRouter));
        assertEq(
            uint8(netFlow.outboundFlow()),
            uint8(NetFlowRateLimitedHookIsm.FlowDirection.CONSUME)
        );
        assertEq(netFlow.localCollateral(), 100 ether);
        assertEq(netFlow.maxCapacity(), 10 ether);
        assertEq(netFlow.calculateCurrentLevel(), 10 ether);
    }

    function test_syntheticOutboundConsumesNetFlow() external {
        localRouter.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            9 ether
        );

        assertEq(localRouter.totalSupply(), 91 ether);
        assertEq(netFlow.calculateCurrentLevel(), 0.1 ether);
    }

    function test_syntheticInboundCreditsNetFlow() external {
        localRouter.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            9 ether
        );
        assertEq(netFlow.calculateCurrentLevel(), 0.1 ether);

        localMailbox.process(bytes(""), _inboundMessage(5 ether));

        assertEq(localRouter.totalSupply(), 96 ether);
        assertEq(netFlow.calculateCurrentLevel(), 5.1 ether);
    }

    function test_syntheticOutboundRevertsIfNetOutflowExceedsSupplyBps()
        external
    {
        vm.expectRevert("RateLimitExceeded");
        localRouter.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            11 ether
        );
    }

    function _inboundMessage(
        uint256 amount
    ) internal view returns (bytes memory) {
        return
            localMailbox.buildInboundMessage(
                DESTINATION,
                address(localRouter).addressToBytes32(),
                address(remoteRouter).addressToBytes32(),
                TokenMessage.format(BOB.addressToBytes32(), amount, bytes(""))
            );
    }
}

contract NetFlowRateLimitedHookIsmNativeTest is Test {
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant MAX_FLOW_BPS = 1_000; // 10%
    uint256 internal constant SCALE = 1;
    address constant BOB = address(0x2);

    TestMailbox localMailbox;
    TestMailbox remoteMailbox;
    TestPostDispatchHook noopHook;
    HypNative localRouter;
    HypNative remoteRouter;
    NetFlowRateLimitedHookIsm netFlow;

    function setUp() external {
        localMailbox = new TestMailbox(DESTINATION);
        remoteMailbox = new TestMailbox(ORIGIN);
        noopHook = new TestPostDispatchHook();

        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        localRouter = new HypNative(SCALE, SCALE, address(localMailbox));
        remoteRouter = new HypNative(SCALE, SCALE, address(remoteMailbox));

        netFlow = new NetFlowRateLimitedHookIsm(
            address(localMailbox),
            address(localRouter),
            MAX_FLOW_BPS
        );

        localRouter.initialize(
            address(netFlow),
            address(netFlow),
            address(this)
        );
        remoteRouter.initialize(address(noopHook), address(0), address(this));

        localRouter.enrollRemoteRouter(
            ORIGIN,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            DESTINATION,
            address(localRouter).addressToBytes32()
        );

        vm.deal(address(localRouter), 100 ether);
    }

    function test_nativeInitialCapacity_isBalanceBps() external view {
        assertEq(netFlow.capacityToken(), address(0));
        assertEq(
            uint8(netFlow.outboundFlow()),
            uint8(NetFlowRateLimitedHookIsm.FlowDirection.CREDIT)
        );
        assertEq(netFlow.localCollateral(), 100 ether);
        assertEq(netFlow.maxCapacity(), 10 ether);
        assertEq(netFlow.calculateCurrentLevel(), 10 ether);
    }

    function test_nativeInboundConsumesNetFlow() external {
        localMailbox.process(bytes(""), _inboundMessage(9 ether));

        assertEq(BOB.balance, 9 ether);
        assertEq(address(localRouter).balance, 91 ether);
        assertEq(netFlow.calculateCurrentLevel(), 1 ether);
    }

    function test_nativeOutboundCreditsNetFlow() external {
        localMailbox.process(bytes(""), _inboundMessage(9 ether));
        assertEq(netFlow.calculateCurrentLevel(), 1 ether);

        localRouter.transferRemote{value: 5 ether}(
            ORIGIN,
            BOB.addressToBytes32(),
            5 ether
        );

        assertEq(address(localRouter).balance, 96 ether);
        assertEq(netFlow.calculateCurrentLevel(), 6 ether);
    }

    function _inboundMessage(
        uint256 amount
    ) internal view returns (bytes memory) {
        return
            localMailbox.buildInboundMessage(
                ORIGIN,
                address(localRouter).addressToBytes32(),
                address(remoteRouter).addressToBytes32(),
                TokenMessage.format(BOB.addressToBytes32(), amount, bytes(""))
            );
    }
}
