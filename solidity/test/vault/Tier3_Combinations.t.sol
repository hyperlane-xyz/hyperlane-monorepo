// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MultiChainVaultTest} from "./MultiChainVault.t.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";

contract Tier3_CombinationsTest is MultiChainVaultTest {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    function test_C8_HubDepositAndSpokeNavSync() public {
        // User deposits 100k to Hub
        vm.prank(alice);
        uint256 shares = hubVault.deposit(100_000e18, alice);
        assertGt(shares, 0);

        // Spoke A deposits 50k into local yield strategy
        underlyingAsset.mint(address(adapterA), 50_000e18);
        vm.prank(owner);
        adapterA.depositToYieldStrategy(50_000e18, 0);

        // Spoke A syncs NAV to Hub via Mailbox
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0.1 ether}(0.1 ether);

        // Deliver message
        mailboxA.deliverMessage(0);

        // Hub reflects updated total portfolio NAV: 100k local + 50k Spoke A = 150k
        assertEq(hubVault.totalPortfolioNav(), 150_000e18);
    }

    function test_C9_SpokeYieldAccretionAndMessageEncoding() public {
        underlyingAsset.mint(address(adapterA), 40_000e18);
        vm.prank(owner);
        adapterA.depositToYieldStrategy(40_000e18, 0);

        // Yield occurs on Spoke A (+10k)
        strategyVaultA.addYield(10_000e18);
        assertApproxEqAbs(adapterA.getStrategyNav(), 50_000e18, 1);

        // Sync NAV to Hub
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0.1 ether}(0.1 ether);

        // Decode dispatched message body from mailboxA
        (, , , , , bytes memory msgData, ) = mailboxA.dispatchedMessages(0);
        CrossChainVaultMessage.Message memory parsed = CrossChainVaultMessage.parseMemory(msgData);

        assertEq(parsed.msgType, CrossChainVaultMessage.TYPE_NAV_REPORT);
        assertApproxEqAbs(parsed.amount, 50_000e18, 1);
    }

    function test_C10_DriftTriggerEncodesRebalanceOrder() public {
        // Setup initial NAV: Spoke A = 90k, Spoke B = 10k (target 50/50 -> 40% drift)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 90_000e18, block.timestamp, "");
        bytes memory msgB = CrossChainVaultMessage.encodeNavReport(address(adapterB).addressToBytes32(), 10_000e18, block.timestamp, "");

        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_B, address(adapterB).addressToBytes32(), msgB);

        (uint256 maxDrift, bool needsRebalance) = hubVault.calculateDrift();
        assertTrue(needsRebalance);
        assertEq(maxDrift, 4000);

        // Dispatch rebalance order: 40k from A to B
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 40_000e18,
            minAmountOut: 39_000e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.2 ether}(orders, 0.1 ether);

        assertEq(mailboxHub.nonceCounter(), 2);
    }

    function test_C11_TwoLayerAuthProtectsRebalanceExecution() public {
        underlyingAsset.mint(address(adapterA), 50_000e18);
        vm.prank(owner);
        adapterA.depositToYieldStrategy(50_000e18, 0);

        bytes memory rebalanceMsg = CrossChainVaultMessage.encodeRebalanceExecute(
            address(adapterB).addressToBytes32(),
            20_000e18,
            19_000e18,
            block.timestamp + 3600,
            ""
        );

        // Layer 1 validation: Revert if not from Mailbox
        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), rebalanceMsg);

        // Layer 2 validation: Revert if origin domain is wrong
        vm.prank(address(mailboxA));
        vm.expectRevert("Unauthorized: origin domain mismatch");
        adapterA.handle(9999, address(hubVault).addressToBytes32(), rebalanceMsg);

        // Successful execution with valid authentication
        vm.prank(address(mailboxA));
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), rebalanceMsg);

        assertEq(strategyVaultA.totalAssets(), 30_000e18);
    }

    function test_C12_PerformanceFeeAccruesOnAuthenticatedNavReport() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        // Yield occurs on Spoke A (+30k profit)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 130_000e18, block.timestamp, "");

        // Authenticated handle
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        // Accrue performance fee (10% on 30k = 3k)
        hubVault.accrueFees();

        uint256 feeShares = hubVault.balanceOf(feeRecipient);
        assertGt(feeShares, 0);
    }

    function test_C13_ManagementFeeAndUserRedemptionInvariant() public {
        vm.prank(alice);
        uint256 aliceShares = hubVault.deposit(100_000e18, alice);

        // 6 months elapse
        vm.warp(block.timestamp + 180 days);
        hubVault.accrueFees();

        // Alice redeems half her shares
        vm.prank(alice);
        uint256 withdrawn = hubVault.redeem(aliceShares / 2, alice, alice);

        assertGt(withdrawn, 0);
        // Invariant holds: totalPortfolioNav() == totalAssets()
        assertEq(hubVault.totalPortfolioNav(), hubVault.totalAssets());
    }
}
