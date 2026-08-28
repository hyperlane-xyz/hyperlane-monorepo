// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MultiChainVaultTest} from "./MultiChainVault.t.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";

contract Tier1_FeaturesTest is MultiChainVaultTest {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ==========================================
    // Feature 8: MultiChainVaultHub (5 tests)
    // ==========================================

    function test_F8_1_DecimalsOffset() public {
        assertEq(hubVault.decimals(), 21, "Decimals must be underlying (18) + offset (3)");
        assertEq(hubVault.asset(), address(underlyingAsset));
        assertEq(hubVault.totalAssets(), 0);
        assertEq(hubVault.totalSupply(), 0);
    }

    function test_F8_2_DepositAndShareMinting() public {
        uint256 depositAmount = 10_000e18;
        vm.prank(alice);
        uint256 shares = hubVault.deposit(depositAmount, alice);

        assertGt(shares, 0);
        assertEq(hubVault.balanceOf(alice), shares);
        assertEq(hubVault.totalAssets(), depositAmount);
        assertEq(underlyingAsset.balanceOf(address(hubVault)), depositAmount);
    }

    function test_F8_3_TotalPortfolioNav() public {
        uint256 depositAmount = 20_000e18;
        vm.prank(alice);
        hubVault.deposit(depositAmount, alice);

        // Deliver NAV reports from Spoke A (10k) and Spoke B (15k)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 10_000e18, block.timestamp, "");
        bytes memory msgB = CrossChainVaultMessage.encodeNavReport(address(adapterB).addressToBytes32(), 15_000e18, block.timestamp, "");

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_B, address(adapterB).addressToBytes32(), msgB);

        // Portfolio NAV = 20k local + 10k Spoke A + 15k Spoke B = 45k
        assertEq(hubVault.totalPortfolioNav(), 45_000e18);
        assertEq(hubVault.totalAssets(), 45_000e18);
    }

    function test_F8_4_WithdrawalQueueAndBurn() public {
        uint256 depositAmount = 10_000e18;
        vm.prank(alice);
        uint256 shares = hubVault.deposit(depositAmount, alice);

        vm.prank(alice);
        uint256 sharesBurned = hubVault.withdraw(5_000e18, alice, alice);

        assertEq(sharesBurned, 5_000_000e18);
        assertEq(hubVault.balanceOf(alice), shares / 2);
        assertEq(hubVault.totalAssets(), 5_000e18);
    }

    function test_F8_5_StrategyAllocationWeight() public {
        vm.startPrank(owner);
        hubVault.setStrategy(DOMAIN_B, address(adapterB).addressToBytes32(), 3000); // 30%
        hubVault.setStrategy(DOMAIN_A, address(adapterA).addressToBytes32(), 7000); // 70%
        vm.stopPrank();

        IMultiChainVaultHub.StrategyAllocation memory strat = hubVault.getStrategy(DOMAIN_A);
        assertEq(strat.targetWeightBps, 7000);
        assertEq(strat.adapter, address(adapterA).addressToBytes32());
    }

    // ==========================================
    // Feature 9: CrossChainStrategyAdapter (5 tests)
    // ==========================================

    function test_F9_1_AdapterDeploymentAndConfig() public {
        assertEq(adapterA.hubDomain(), DOMAIN_HUB);
        assertEq(adapterA.hubVault(), address(hubVault).addressToBytes32());
        assertEq(address(adapterA.underlyingAsset()), address(underlyingAsset));
        assertEq(address(adapterA.yieldStrategy()), address(strategyVaultA));
    }

    function test_F9_2_SyncNavToHub() public {
        underlyingAsset.mint(address(strategyVaultA), 5_000e18);
        strategyVaultA.addYield(500e18);

        vm.prank(owner);
        adapterA.syncNavToHub{value: 0.1 ether}(0.1 ether);

        // Check mailbox dispatched message
        assertEq(mailboxA.nonceCounter(), 1);
    }

    function test_F9_3_DepositToYieldStrategy() public {
        uint256 amount = 10_000e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.prank(owner);
        adapterA.depositToYieldStrategy(amount, 0);

        assertEq(strategyVaultA.totalAssets(), amount);
    }

    function test_F9_4_WithdrawFromYieldStrategy() public {
        uint256 amount = 10_000e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.startPrank(owner);
        adapterA.depositToYieldStrategy(amount, 0);
        adapterA.withdrawFromYieldStrategy(4_000e18, 0);
        vm.stopPrank();

        assertEq(underlyingAsset.balanceOf(address(adapterA)), 4_000e18);
        assertEq(strategyVaultA.totalAssets(), 6_000e18);
    }

    function test_F9_5_EmergencyUnwind() public {
        uint256 amount = 8_000e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.prank(owner);
        adapterA.depositToYieldStrategy(amount, 0);

        bytes memory unwindMsg = CrossChainVaultMessage.encodeEmergencyUnwind(address(adapterA).addressToBytes32(), 0, block.timestamp + 3600, "");

        vm.prank(address(mailboxA));
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), unwindMsg);

        assertEq(strategyVaultA.totalAssets(), 0);
    }

    // ==========================================
    // Feature 10: CrossChainVaultMessage (5 tests)
    // ==========================================

    function test_F10_1_EncodeDecodeDeposit() public {
        bytes memory msgData = CrossChainVaultMessage.encodeDeposit(
            alice.addressToBytes32(),
            5_000e18,
            4_900e18,
            block.timestamp + 3600,
            ""
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(msgData);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_DEPOSIT);
        assertEq(decoded.amount, 5_000e18);
        assertEq(decoded.recipientOrSender, alice.addressToBytes32());
        assertEq(decoded.minAmountOut, 4_900e18);
        assertEq(decoded.deadline, block.timestamp + 3600);
    }

    function test_F10_2_EncodeDecodeWithdraw() public {
        bytes memory msgData = CrossChainVaultMessage.encodeWithdraw(
            bob.addressToBytes32(),
            2_500e18,
            2_450e18,
            block.timestamp + 1800,
            ""
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(msgData);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_WITHDRAW);
        assertEq(decoded.amount, 2_500e18);
        assertEq(decoded.recipientOrSender, bob.addressToBytes32());
        assertEq(decoded.minAmountOut, 2_450e18);
    }

    function test_F10_3_EncodeDecodeNavReport() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            12_000e18,
            block.timestamp,
            ""
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(msgData);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_NAV_REPORT);
        assertEq(decoded.amount, 12_000e18);
        assertEq(decoded.recipientOrSender, address(adapterA).addressToBytes32());
    }

    function test_F10_4_EncodeDecodeRebalanceExecute() public {
        bytes memory msgData = CrossChainVaultMessage.encodeRebalanceExecute(
            address(adapterB).addressToBytes32(),
            7_000e18,
            6_900e18,
            block.timestamp + 7200,
            ""
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(msgData);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_REBALANCE_EXECUTE);
        assertEq(decoded.amount, 7_000e18);
        assertEq(decoded.recipientOrSender, address(adapterB).addressToBytes32());
        assertEq(decoded.minAmountOut, 6_900e18);
    }

    function test_F10_5_EncodeDecodeEmergencyUnwind() public {
        bytes memory msgData = CrossChainVaultMessage.encodeEmergencyUnwind(
            address(adapterA).addressToBytes32(),
            1_000e18,
            block.timestamp + 3600,
            ""
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(msgData);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_EMERGENCY_UNWIND);
        assertEq(decoded.recipientOrSender, address(adapterA).addressToBytes32());
        assertEq(decoded.minAmountOut, 1_000e18);
    }

    // ==========================================
    // Feature 11: VaultRebalanceEngine (5 tests)
    // ==========================================

    function test_F11_1_DriftCalculationExact() public {
        // Hub target 50% Domain A, 50% Domain B
        // Deliver reports: Domain A = 80k (80%), Domain B = 20k (20%) -> Drift is 30% (3000 bps)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 80_000e18, block.timestamp, "");
        bytes memory msgB = CrossChainVaultMessage.encodeNavReport(address(adapterB).addressToBytes32(), 20_000e18, block.timestamp, "");

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_B, address(adapterB).addressToBytes32(), msgB);

        (uint256 maxDriftBps, bool needsRebalance) = hubVault.calculateDrift();

        assertEq(maxDriftBps, 3000, "Max drift should be 30% (3000 bps)");
        assertTrue(needsRebalance, "Needs rebalance must be true");
    }

    function test_F11_2_DriftBelowThresholdNoTrigger() public {
        // Drift is 2% (200 bps) which is below DRIFT_THRESHOLD_BPS (500 bps)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 52_000e18, block.timestamp, "");
        bytes memory msgB = CrossChainVaultMessage.encodeNavReport(address(adapterB).addressToBytes32(), 48_000e18, block.timestamp, "");

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_B, address(adapterB).addressToBytes32(), msgB);

        (uint256 maxDriftBps, bool needsRebalance) = hubVault.calculateDrift();
        assertFalse(needsRebalance, "Needs rebalance must be false when drift < 500 bps");
        assertEq(maxDriftBps, 200);
    }

    function test_F11_3_DriftAboveThresholdTriggersRebalance() public {
        // Domain A = 80k, Domain B = 20k -> 30% drift > 5% threshold
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 80_000e18, block.timestamp, "");
        bytes memory msgB = CrossChainVaultMessage.encodeNavReport(address(adapterB).addressToBytes32(), 20_000e18, block.timestamp, "");

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_B, address(adapterB).addressToBytes32(), msgB);

        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 30_000e18,
            minAmountOut: 29_000e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.2 ether}(orders, 0.1 ether);

        assertEq(mailboxHub.nonceCounter(), 2);
    }

    function test_F11_4_RebalanceZeroAmountReverts() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 0,
            minAmountOut: 0,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        vm.expectRevert("Rebalance amount must be greater than zero");
        hubVault.triggerRebalance(orders, 0);
    }

    function test_F11_5_RebalanceDeadlineEnforcement() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 10_000e18,
            minAmountOut: 9_900e18,
            deadline: block.timestamp - 1 // Expired deadline
        });

        vm.prank(owner);
        vm.expectRevert("Rebalance order expired: deadline passed");
        hubVault.triggerRebalance(orders, 0);
    }

    // ==========================================
    // Feature 12: MailboxSecurityAndAuth (5 tests)
    // ==========================================

    function test_F12_1_OnlyMailboxModifierOnHub() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 10_000e18, block.timestamp, "");

        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);
    }

    function test_F12_2_OriginAndSenderValidationOnHub() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(attacker.addressToBytes32(), 10_000e18, block.timestamp, "");

        // From Mailbox, but with attacker as sender
        vm.prank(address(mailboxHub));
        vm.expectRevert("Unauthorized: sender adapter mismatch");
        hubVault.handle(DOMAIN_A, attacker.addressToBytes32(), msgData);
    }

    function test_F12_3_OnlyMailboxModifierOnAdapter() public {
        bytes memory unwindMsg = CrossChainVaultMessage.encodeEmergencyUnwind(address(adapterA).addressToBytes32(), 0, block.timestamp + 3600, "");

        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), unwindMsg);
    }

    function test_F12_4_OriginAndSenderValidationOnAdapter() public {
        bytes memory unwindMsg = CrossChainVaultMessage.encodeEmergencyUnwind(address(adapterA).addressToBytes32(), 0, block.timestamp + 3600, "");

        // From Spoke Mailbox, but origin is wrong (attacker domain)
        vm.prank(address(mailboxA));
        vm.expectRevert("Unauthorized: origin domain mismatch");
        adapterA.handle(9999, address(hubVault).addressToBytes32(), unwindMsg);
    }

    function test_F12_5_UnauthorizedPauseExecution() public {
        vm.prank(attacker);
        vm.expectRevert();
        hubVault.pause();
    }

    // ==========================================
    // Feature 13: FeeAccrualAndAccounting (5 tests)
    // ==========================================

    function test_F13_1_ManagementFeeContinuousAccrual() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        // Warp 1 year (365 days)
        vm.warp(block.timestamp + 365 days);

        hubVault.accrueFees();

        // 2% per year on 100k -> fee recipient gets shares
        uint256 feeShares = hubVault.balanceOf(feeRecipient);
        assertGt(feeShares, 0);
    }

    function test_F13_2_ZeroFeeWhenNoTimeElapsed() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        hubVault.accrueFees();
        assertEq(hubVault.balanceOf(feeRecipient), 0);
    }

    function test_F13_3_PerformanceFeeOnGainsAboveHWM() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        // Report 20k yield on Spoke A (NAV becomes 120k)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 120_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        // Accrue fees -> 10% performance fee on 20k profit
        hubVault.accrueFees();

        uint256 feeShares = hubVault.balanceOf(feeRecipient);
        assertGt(feeShares, 0);
    }

    function test_F13_4_NoPerformanceFeeOnNAVDrawdown() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        // 1. Establish initial profitable NAV and HWM (50k profit on Spoke A)
        bytes memory msgProfit = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 50_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgProfit);
        hubVault.accrueFees();
        uint256 feeSharesBefore = hubVault.balanceOf(feeRecipient);
        assertGt(feeSharesBefore, 0);

        // 2. Report loss/drawdown on Spoke A (NAV drops from 50k to 20k)
        bytes memory msgDrawdown = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 20_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgDrawdown);

        hubVault.accrueFees();

        // 3. No additional performance fee on drawdown
        assertEq(hubVault.balanceOf(feeRecipient), feeSharesBefore);
    }

    function test_F13_5_HighWaterMarkUpdatesOnPerformanceFee() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        uint256 initialHwm = hubVault.highWaterMarkNavPerShare();

        // Report profit
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 150_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        hubVault.accrueFees();

        uint256 newHwm = hubVault.highWaterMarkNavPerShare();
        assertGt(newHwm, initialHwm);
    }
}
