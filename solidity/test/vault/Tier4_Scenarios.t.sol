// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MultiChainVaultTest} from "./MultiChainVault.t.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";

contract Tier4_ScenariosTest is MultiChainVaultTest {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    function test_S3_MultiDomainVaultLifecycleWithYieldAndRebalancing() public {
        // 1. Initial user deposits on Hub (100k from Alice, 50k from Bob)
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);
        vm.prank(bob);
        hubVault.deposit(50_000e18, bob);
        assertEq(hubVault.totalAssets(), 150_000e18);

        // 2. Fund Spoke Adapters (50k each)
        underlyingAsset.mint(address(adapterA), 50_000e18);
        underlyingAsset.mint(address(adapterB), 50_000e18);
        vm.prank(owner);
        adapterA.depositToYieldStrategy(50_000e18, 0);
        vm.prank(owner);
        adapterB.depositToYieldStrategy(50_000e18, 0);

        // 3. Spoke A earns massive yield (+30k), Spoke B stays flat
        strategyVaultA.addYield(30_000e18);

        // 4. Both spokes sync NAV to Hub via Mailbox
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0.1 ether}(0.1 ether);
        vm.prank(owner);
        adapterB.syncNavToHub{value: 0.1 ether}(0.1 ether);

        mailboxA.deliverMessage(0);
        mailboxB.deliverMessage(0);

        // Portfolio NAV is 150k initial + 30k yield = 180k (excluding idle hub balance, Spoke A=80k, Spoke B=50k)
        // Check drift: Spoke A has 80k / 130k = ~61.5% vs 50% target -> drift ~11.5% > 5% threshold
        (uint256 maxDrift, bool needsRebalance) = hubVault.calculateDrift();
        assertTrue(needsRebalance);
        assertGt(maxDrift, 500);

        // 5. Trigger cross-chain rebalance: Shift 15k from Spoke A to Spoke B
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 15_000e18,
            minAmountOut: 14_800e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.2 ether}(orders, 0.1 ether);

        // Deliver rebalance order message to Spoke A (withdraws 15k)
        mailboxHub.deliverMessage(0);
        assertEq(strategyVaultA.totalAssets(), 65_000e18);

        // Simulate Warp Route cross-chain token transfer to Spoke B
        underlyingAsset.mint(address(adapterB), 15_000e18);
        mailboxHub.deliverMessage(1); // Spoke B deposits 15k
        assertEq(strategyVaultB.totalAssets(), 65_000e18);

        // 6. User redemption succeeds smoothly
        uint256 aliceShares = hubVault.balanceOf(alice);
        vm.prank(alice);
        uint256 withdrawnAlice = hubVault.redeem(aliceShares / 2, alice, alice);
        assertGt(withdrawnAlice, 0);
    }

    function test_S4_HighWaterMarkPerformanceFeeMarketCycles() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);
        uint256 initialHwm = hubVault.highWaterMarkNavPerShare();

        // 1. Bull Cycle: Spoke A reports +50k profit
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 150_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        hubVault.accrueFees();
        uint256 bullFeeShares = hubVault.balanceOf(feeRecipient);
        assertGt(bullFeeShares, 0);
        uint256 bullHwm = hubVault.highWaterMarkNavPerShare();
        assertGt(bullHwm, initialHwm);

        // 2. Bear Cycle: Market crashes by 40k (NAV drops to 110k)
        bytes memory msgBear = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 110_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgBear);

        hubVault.accrueFees();
        assertEq(hubVault.balanceOf(feeRecipient), bullFeeShares);
        assertEq(hubVault.highWaterMarkNavPerShare(), bullHwm);

        // 3. Recovery to below previous ATH (NAV rises to 140k): Still no performance fee
        bytes memory msgRecovery = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 140_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgRecovery);

        hubVault.accrueFees();
        assertEq(hubVault.balanceOf(feeRecipient), bullFeeShares);

        // 4. New ATH Cycle (NAV reaches 180k): Performance fee resumes on new gain above HWM
        bytes memory msgAth = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 180_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgAth);

        hubVault.accrueFees();
        assertGt(hubVault.balanceOf(feeRecipient), bullFeeShares);
    }

    function test_S5_EmergencyUnwindingAndPauseUnderExploitAlert() public {
        // Setup spoke positions
        underlyingAsset.mint(address(adapterA), 50_000e18);
        underlyingAsset.mint(address(adapterB), 50_000e18);
        vm.prank(owner);
        adapterA.depositToYieldStrategy(50_000e18, 0);
        vm.prank(owner);
        adapterB.depositToYieldStrategy(50_000e18, 0);

        // Emergency Exploit Alert: Hub dispatches emergency unwind to all spokes
        bytes memory unwindMsgA = CrossChainVaultMessage.encodeEmergencyUnwind(address(adapterA).addressToBytes32(), 0, block.timestamp + 3600, "");
        bytes memory unwindMsgB = CrossChainVaultMessage.encodeEmergencyUnwind(address(adapterB).addressToBytes32(), 0, block.timestamp + 3600, "");

        vm.prank(address(mailboxA));
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), unwindMsgA);
        vm.prank(address(mailboxB));
        adapterB.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), unwindMsgB);

        // Both spoke strategies are fully unwound
        assertEq(strategyVaultA.totalAssets(), 0);
        assertEq(strategyVaultB.totalAssets(), 0);
        assertEq(underlyingAsset.balanceOf(address(adapterA)), 50_000e18);
        assertEq(underlyingAsset.balanceOf(address(adapterB)), 50_000e18);

        // Hub is paused by owner
        vm.prank(owner);
        hubVault.pause();

        // User deposit attempts are blocked
        vm.prank(alice);
        vm.expectRevert();
        hubVault.deposit(10_000e18, alice);
    }
}
