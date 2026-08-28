// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";
import {MockERC20} from "../../contracts/mock/MockERC20.sol";
import {MockERC4626YieldSharing} from "../../contracts/mock/MockERC4626YieldSharing.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";

/**
 * @title MultiChainVaultTest
 * @notice Comprehensive Foundry test suite for Hyperlane Multi-Chain Yield Vault with Rebalancing.
 * Covers ERC-4626 mechanics, 1-wei donation inflation defense, 3-domain NAV telemetry & drift,
 * automated cross-chain rebalancing, slippage & deadlines, fee accounting with High-Water Mark,
 * two-layer authentication, emergency controls, and protocol invariants.
 */
contract MultiChainVaultTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // Test accounts
    address public owner = address(0x1111);
    address public feeRecipient = address(0x2222);
    address public alice = address(0xAAAA);
    address public bob = address(0xBBBB);
    address public attacker = address(0xDEAD);
    address public unauthorized = address(0x9999);

    // Mock Hyperlane Environment
    MockHyperlaneEnvironment public env;
    MockMailbox public mailboxHub;
    MockMailbox public mailboxA;
    MockMailbox public mailboxB;

    // Tokens
    MockERC20 public underlyingAsset;

    // Contracts
    MultiChainVaultHub public hubVault;
    MockERC4626YieldSharing public strategyVaultA;
    MockERC4626YieldSharing public strategyVaultB;
    CrossChainStrategyAdapter public adapterA;
    CrossChainStrategyAdapter public adapterB;

    // Domains
    uint32 public constant DOMAIN_HUB = 1000;
    uint32 public constant DOMAIN_A = 2000;
    uint32 public constant DOMAIN_B = 3000;

    // Default configuration
    uint256 public constant MANAGEMENT_FEE_BPS = 200; // 2% per annum
    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant DRIFT_THRESHOLD_BPS = 500; // 5%

    function setUp() public {
        vm.warp(1_700_000_000); // Set deterministic initial timestamp

        // 1. Deploy Hyperlane Mock Environment
        env = new MockHyperlaneEnvironment();
        mailboxHub = env.mailboxHub();
        mailboxA = env.mailboxSpokeA();
        mailboxB = env.mailboxSpokeB();

        // 2. Deploy Underlying Asset (e.g. WETH / USDC with 18 decimals)
        underlyingAsset = new MockERC20("Cross-Chain Asset", "XASSET", 18);

        // 3. Deploy Hub Vault
        vm.prank(owner);
        hubVault = new MultiChainVaultHub(
            underlyingAsset,
            "Hyperlane Multi-Chain Vault",
            "hVAULT",
            address(mailboxHub),
            DOMAIN_HUB,
            feeRecipient,
            MANAGEMENT_FEE_BPS,
            PERFORMANCE_FEE_BPS,
            DRIFT_THRESHOLD_BPS
        );

        bytes32 hubVaultBytes32 = address(hubVault).addressToBytes32();

        // 4. Deploy Spoke Yield Strategies
        strategyVaultA = new MockERC4626YieldSharing(underlyingAsset, "Renzo Strategy A", "renA");
        strategyVaultB = new MockERC4626YieldSharing(underlyingAsset, "Pendle Strategy B", "penB");

        // 5. Deploy Spoke Adapters
        vm.startPrank(owner);
        adapterA = new CrossChainStrategyAdapter(
            address(mailboxA),
            DOMAIN_HUB,
            hubVaultBytes32,
            address(underlyingAsset),
            address(strategyVaultA),
            owner
        );

        adapterB = new CrossChainStrategyAdapter(
            address(mailboxB),
            DOMAIN_HUB,
            hubVaultBytes32,
            address(underlyingAsset),
            address(strategyVaultB),
            owner
        );

        // 6. Register Spoke Strategies in Hub Vault (50% target weight each)
        hubVault.setStrategy(DOMAIN_A, address(adapterA).addressToBytes32(), 5000);
        hubVault.setStrategy(DOMAIN_B, address(adapterB).addressToBytes32(), 5000);
        vm.stopPrank();

        // 7. Fund user accounts
        underlyingAsset.mint(alice, 1_000_000e18);
        underlyingAsset.mint(bob, 1_000_000e18);
        underlyingAsset.mint(attacker, 1_000_000e18);

        vm.prank(alice);
        underlyingAsset.approve(address(hubVault), type(uint256).max);

        vm.prank(bob);
        underlyingAsset.approve(address(hubVault), type(uint256).max);

        vm.prank(attacker);
        underlyingAsset.approve(address(hubVault), type(uint256).max);

        // Give ETH for gas payments
        vm.deal(owner, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(adapterA), 100 ether);
        vm.deal(address(adapterB), 100 ether);
    }

    // External helper to test internal library reverts via contract call
    function parseMessageExternal(bytes memory data) external pure returns (CrossChainVaultMessage.Message memory) {
        return CrossChainVaultMessage.parseMemory(data);
    }

    // =========================================================================
    // SECTION 1: Standard ERC-4626 Mechanics & Virtual Offset Checks
    // =========================================================================

    function test_DecimalsAndOffset() public {
        // Underlying decimals (18) + virtual offset (3) = 21
        assertEq(hubVault.decimals(), 21);
        assertEq(hubVault.asset(), address(underlyingAsset));
        assertEq(hubVault.totalAssets(), 0);
        assertEq(hubVault.totalSupply(), 0);
    }

    function test_DepositAndMintMechanics() public {
        uint256 depositAmount = 10_000e18;

        vm.prank(alice);
        uint256 shares = hubVault.deposit(depositAmount, alice);

        // With offset=3, shares = assets * 1000 / 1 = 10_000e18 * 1000 = 10_000_000e18
        assertGt(shares, 0);
        assertEq(hubVault.balanceOf(alice), shares);
        assertEq(hubVault.totalAssets(), depositAmount);
        assertEq(underlyingAsset.balanceOf(address(hubVault)), depositAmount);

        // Bob mints exact shares
        uint256 mintShares = 5_000_000e18;
        uint256 expectedAssets = hubVault.previewMint(mintShares);

        vm.prank(bob);
        uint256 assetsPaid = hubVault.mint(mintShares, bob);

        assertEq(assetsPaid, expectedAssets);
        assertEq(hubVault.balanceOf(bob), mintShares);
        assertEq(hubVault.totalAssets(), depositAmount + assetsPaid);
    }

    function test_WithdrawAndRedeemMechanics() public {
        uint256 depositAmount = 20_000e18;
        vm.prank(alice);
        uint256 shares = hubVault.deposit(depositAmount, alice);
        assertGt(shares, 0);

        // Alice withdraws half the assets
        uint256 withdrawAmount = 10_000e18;
        uint256 expectedShares = hubVault.previewWithdraw(withdrawAmount);

        vm.prank(alice);
        uint256 sharesBurned = hubVault.withdraw(withdrawAmount, alice, alice);

        assertEq(sharesBurned, expectedShares);
        assertEq(hubVault.totalAssets(), 10_000e18);
        assertEq(underlyingAsset.balanceOf(alice), 1_000_000e18 - 10_000e18);

        // Alice redeems remaining shares
        uint256 remainingShares = hubVault.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsReturned = hubVault.redeem(remainingShares, alice, alice);

        assertEq(assetsReturned, 10_000e18);
        assertEq(hubVault.balanceOf(alice), 0);
        assertEq(underlyingAsset.balanceOf(alice), 1_000_000e18);
    }

    // =========================================================================
    // SECTION 2: 1-Wei Donation / Inflation Attack Defense Verification
    // =========================================================================

    function test_InflationAttackDefense_VirtualOffsetProtectsVictim() public {
        // Step 1: Attacker deposits 1 wei
        vm.prank(attacker);
        uint256 attackerShares = hubVault.deposit(1, attacker);
        // With offset=3, attacker gets 1000 shares (1 * 1000 / 1)
        assertEq(attackerShares, 1000);

        // Step 2: Attacker donates 100,000 tokens directly to the vault to inflate share price
        uint256 donationAmount = 100_000e18;
        vm.prank(attacker);
        bool donated = underlyingAsset.transfer(address(hubVault), donationAmount);
        assertTrue(donated);

        // Total assets now = donationAmount + 1
        assertEq(hubVault.totalAssets(), donationAmount + 1);

        // Step 3: Victim deposits 1,000 tokens
        uint256 victimDeposit = 1_000e18;
        vm.prank(alice);
        uint256 victimShares = hubVault.deposit(victimDeposit, alice);

        // In a vulnerable vault without offset, victimShares would round down to 0, losing 100% of funds.
        // In MultiChainVaultHub with virtual offset 3 (1000 virtual shares, 1 virtual asset):
        // victimShares = victimDeposit * (totalSupply + 1000) / (totalAssets + 1)
        // victimShares > 0 is guaranteed and non-zero!
        assertGt(victimShares, 0);

        // Step 4: Victim withdraws their deposit
        vm.prank(alice);
        uint256 victimRecovered = hubVault.redeem(victimShares, alice, alice);

        // Victim recovers virtually all of their deposit (> 95%)
        assertApproxEqRel(victimRecovered, victimDeposit, 0.06e18);

        // Step 5: Attacker tries to redeem their initial shares
        vm.prank(attacker);
        uint256 attackerRecovered = hubVault.redeem(attackerShares, attacker, attacker);

        // Attacker gets back ~0.001 of the total pool, suffering massive net loss of their donation!
        assertLt(attackerRecovered, donationAmount);
    }

    // =========================================================================
    // SECTION 3: Spoke Strategy Adapter Lifecycle & Local Yield
    // =========================================================================

    function test_SpokeAdapterDepositAndWithdraw() public {
        uint256 depositAmount = 5_000e18;
        underlyingAsset.mint(address(adapterA), depositAmount);

        // Execute deposit to strategy A
        vm.prank(owner);
        uint256 sharesMinted = adapterA.depositToYieldStrategy(depositAmount, depositAmount);
        assertEq(sharesMinted, depositAmount);
        assertEq(adapterA.getStrategyNav(), depositAmount);

        // Strategy A generates yield (+10%)
        strategyVaultA.simulateYield(1000); // 10%
        assertApproxEqAbs(adapterA.getStrategyNav(), 5_500e18, 1);

        // Withdraw 2,000 assets from strategy
        vm.prank(owner);
        uint256 assetsReceived = adapterA.withdrawFromYieldStrategy(2_000e18, 2_000e18);
        assertEq(assetsReceived, 2_000e18);
        assertApproxEqAbs(adapterA.getStrategyNav(), 5_500e18, 1); // 3,500 in strategy + 2,000 in idle underlying
    }

    function test_SpokeAdapterSyncNavToHubViaMailbox() public {
        uint256 depositAmount = 10_000e18;
        underlyingAsset.mint(address(adapterA), depositAmount);

        vm.prank(owner);
        adapterA.depositToYieldStrategy(depositAmount, depositAmount);

        // Sync NAV to Hub
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0}(0);

        // Verify message was dispatched to Hub mailbox
        assertEq(mailboxA.getDispatchedCount(), 1);

        // Relay message to Hub
        mailboxA.relayAll();

        // Verify Hub updated strategy A's reported NAV
        IMultiChainVaultHub.StrategyAllocation memory stratA = hubVault.getStrategy(DOMAIN_A);
        assertEq(stratA.lastReportedNav, depositAmount);
        assertEq(hubVault.totalPortfolioNav(), depositAmount);
    }

    // =========================================================================
    // SECTION 4: 3-Domain NAV Aggregation & Portfolio Drift Calculation
    // =========================================================================

    function test_ThreeDomainNavAggregationAndDriftEngine() public {
        // Fund Strategy A with 5,000 and Strategy B with 5,000
        underlyingAsset.mint(address(adapterA), 5_000e18);
        underlyingAsset.mint(address(adapterB), 5_000e18);

        vm.startPrank(owner);
        adapterA.depositToYieldStrategy(5_000e18, 5_000e18);
        adapterB.depositToYieldStrategy(5_000e18, 5_000e18);

        adapterA.syncNavToHub{value: 0}(0);
        adapterB.syncNavToHub{value: 0}(0);
        vm.stopPrank();

        mailboxA.relayAll();
        mailboxB.relayAll();

        // Verify Total Portfolio NAV = 10,000
        assertEq(hubVault.totalPortfolioNav(), 10_000e18);

        // Check drift: 50% vs 50% target = 0 bps drift, needsRebalance = false
        (uint256 maxDriftBps, bool needsRebalance) = hubVault.calculateDrift();
        assertEq(maxDriftBps, 0);
        assertFalse(needsRebalance);

        // Strategy A gains yield (+2,000e18) -> NAV becomes 7,000
        strategyVaultA.addYield(2_000e18);
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0}(0);
        mailboxA.relayAll();

        // Total NAV = 7,000 + 5,000 = 12,000
        assertApproxEqAbs(hubVault.totalPortfolioNav(), 12_000e18, 1);

        // Strategy A weight: 7000/12000 = 58.33% (5833 bps) -> Drift = 833 bps
        // Strategy B weight: 5000/12000 = 41.67% (4167 bps) -> Drift = 833 bps
        // Since 833 bps > driftThresholdBps (500 bps), needsRebalance must be TRUE
        (maxDriftBps, needsRebalance) = hubVault.calculateDrift();
        assertApproxEqAbs(maxDriftBps, 833, 2);
        assertTrue(needsRebalance);
    }

    // =========================================================================
    // SECTION 5: Automated Cross-Chain Rebalancing Across 3 Domains
    // =========================================================================

    function test_AutomatedCrossChainRebalancingAcross3Domains() public {
        // Initial setup: Spoke A = 7,000, Spoke B = 5,000 (Drift = 833 bps, needs rebalancing)
        underlyingAsset.mint(address(adapterA), 5_000e18);
        underlyingAsset.mint(address(adapterB), 5_000e18);

        vm.startPrank(owner);
        adapterA.depositToYieldStrategy(5_000e18, 5_000e18);
        adapterB.depositToYieldStrategy(5_000e18, 5_000e18);
        strategyVaultA.addYield(2_000e18);

        adapterA.syncNavToHub{value: 0}(0);
        adapterB.syncNavToHub{value: 0}(0);
        vm.stopPrank();

        mailboxA.relayAll();
        mailboxB.relayAll();

        // Mint bridged tokens to Spoke B adapter for the incoming deposit
        underlyingAsset.mint(address(adapterB), 1_000e18);

        // Rebalance order: shift 1,000 from Spoke A to Spoke B
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 1_000e18,
            minAmountOut: 990e18, // 1% slippage tolerance
            deadline: block.timestamp + 1 hours
        });

        // Trigger rebalance on Hub
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0}(orders, 0);

        // Hub dispatches messages to MailboxHub
        assertEq(mailboxHub.getDispatchedCount(), 2); // 1 to Spoke A (withdraw), 1 to Spoke B (deposit)

        // Relay messages to Spoke A and Spoke B
        mailboxHub.relayAll();

        // Spoke A received withdraw instruction and unwound 1,000
        // Simulate warp route bridging outbound transfer from Spoke A adapter
        vm.prank(address(adapterA));
        bool bridged = underlyingAsset.transfer(address(0xDEAD), 1_000e18);
        assertTrue(bridged);

        // Spoke B received deposit instruction and invested 1,000 into strategy B
        assertEq(strategyVaultB.totalAssets(), 6_000e18);

        // Both adapters sync new NAVs back to Hub
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0}(0);
        vm.prank(owner);
        adapterB.syncNavToHub{value: 0}(0);

        mailboxA.relayAll();
        mailboxB.relayAll();

        // Check drift after rebalance: Spoke A = 6,000, Spoke B = 6,000 (50%/50%) -> Drift <= 1 bps
        (uint256 maxDriftBps, bool needsRebalance) = hubVault.calculateDrift();
        assertApproxEqAbs(maxDriftBps, 0, 2);
        assertFalse(needsRebalance);
    }

    // =========================================================================
    // SECTION 6: Slippage Protection & Deadline Enforcement
    // =========================================================================

    function test_RebalanceRevertsOnExpiredDeadline() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 1_000e18,
            minAmountOut: 990e18,
            deadline: block.timestamp - 1 // Expired
        });

        vm.expectRevert("Rebalance order expired: deadline passed");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0}(orders, 0);
    }

    function test_RebalanceRevertsOnZeroAmountOrMinOut() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders1 = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders1[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 0,
            minAmountOut: 100,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert("Rebalance amount must be greater than zero");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0}(orders1, 0);

        IMultiChainVaultHub.RebalanceOrder[] memory orders2 = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders2[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 100,
            minAmountOut: 0,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert("minAmountOut must be greater than zero");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0}(orders2, 0);
    }

    function test_SpokeAdapterDepositSlippageProtection() public {
        underlyingAsset.mint(address(adapterA), 1_000e18);

        // Require more shares than the deposit can produce
        vm.expectRevert("Slippage: minSharesOut condition violated");
        vm.prank(owner);
        adapterA.depositToYieldStrategy(1_000e18, 1_001e18);
    }

    function test_SpokeAdapterWithdrawSlippageProtection() public {
        underlyingAsset.mint(address(adapterA), 1_000e18);

        vm.prank(owner);
        adapterA.depositToYieldStrategy(1_000e18, 1_000e18);

        vm.expectRevert("Slippage: minAssetsOut condition violated");
        vm.prank(owner);
        adapterA.withdrawFromYieldStrategy(500e18, 501e18);
    }

    // =========================================================================
    // SECTION 7: Management & Performance Fees with High-Water Mark (HWM)
    // =========================================================================

    function test_ManagementFeeAccrualOverTime() public {
        // Alice deposits 10,000 tokens
        vm.prank(alice);
        hubVault.deposit(10_000e18, alice);

        // Advance time by 1 year (365 days)
        vm.warp(block.timestamp + 365 days);

        // Management fee = 2% of 10,000 = 200 tokens
        hubVault.accrueFees();

        uint256 feeShares = hubVault.balanceOf(feeRecipient);
        assertGt(feeShares, 0);

        uint256 feeAssets = hubVault.convertToAssets(feeShares);
        assertApproxEqAbs(feeAssets, 200e18, 5e18);
    }

    function test_PerformanceFeeWithHighWaterMarkTracking() public {
        // 1. Initial Deposit by Alice: 10,000 tokens
        vm.prank(alice);
        hubVault.deposit(10_000e18, alice);

        uint256 initialHwm = hubVault.highWaterMarkNavPerShare();

        // 2. Hub earns yield: +2,000 tokens directly (NAV increases from 10,000 to 12,000)
        underlyingAsset.mint(address(hubVault), 2_000e18);

        // Accrue fees: 10% performance fee on 2,000 profit = 200 tokens
        hubVault.accrueFees();

        uint256 feeRecipientShares = hubVault.balanceOf(feeRecipient);
        assertGt(feeRecipientShares, 0);

        uint256 feeAssets = hubVault.convertToAssets(feeRecipientShares);
        assertApproxEqAbs(feeAssets, 200e18, 5e18);

        // High water mark must have increased
        uint256 newHwm = hubVault.highWaterMarkNavPerShare();
        assertGt(newHwm, initialHwm);

        // 3. Subsequent period with NO profit (NAV stays constant)
        uint256 sharesBefore = hubVault.balanceOf(feeRecipient);
        vm.warp(block.timestamp + 10 days); // small time jump
        hubVault.accrueFees();
        uint256 sharesAfter = hubVault.balanceOf(feeRecipient);

        // Only tiny management fee, ZERO performance fee
        uint256 additionalShares = sharesAfter - sharesBefore;
        uint256 additionalAssets = hubVault.convertToAssets(additionalShares);
        // Over 10 days on 12000 NAV, management fee is ~6.5 assets
        assertLt(additionalAssets, 10e18);

        // 4. Market Downturn: NAV drops to 11,000
        // Burn 1,000 tokens from hubVault
        vm.prank(address(hubVault));
        underlyingAsset.burn(address(hubVault), 1_000e18);

        hubVault.accrueFees();
        // HWM remains unchanged at high water mark
        assertEq(hubVault.highWaterMarkNavPerShare(), newHwm);

        // 5. Market Recovery to 14,000 (+2,000 above previous peak of 12,000)
        underlyingAsset.mint(address(hubVault), 3_000e18);
        uint256 sharesBeforeRecovery = hubVault.balanceOf(feeRecipient);

        hubVault.accrueFees();

        uint256 sharesAfterRecovery = hubVault.balanceOf(feeRecipient);
        uint256 perfFeeAssets = hubVault.convertToAssets(sharesAfterRecovery - sharesBeforeRecovery);

        // Performance fee charged ONLY on gain above previous HWM (~177 fee after dilution and time fee)
        assertApproxEqAbs(perfFeeAssets, 177e18, 10e18);
        assertGt(hubVault.highWaterMarkNavPerShare(), newHwm);
    }

    // =========================================================================
    // SECTION 8: Two-Layer Authorization & Message Rejection
    // =========================================================================

    function test_HubRejectsUnauthorizedCallers() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            10_000e18,
            block.timestamp,
            ""
        );

        // Call from non-mailbox reverts
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        vm.prank(unauthorized);
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);

        // Call from mailbox with unregistered domain reverts
        vm.expectRevert("Unauthorized: origin domain not registered");
        vm.prank(address(mailboxHub));
        hubVault.handle(9999, address(adapterA).addressToBytes32(), msgData);

        // Call from mailbox with sender mismatch reverts
        vm.expectRevert("Unauthorized: sender adapter mismatch");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(unauthorized).addressToBytes32(), msgData);
    }

    function test_SpokeAdapterRejectsUnauthorizedCallers() public {
        bytes memory msgData = CrossChainVaultMessage.encodeDeposit(
            address(adapterA).addressToBytes32(),
            1_000e18,
            1_000e18,
            block.timestamp,
            ""
        );

        // Call from non-mailbox reverts
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        vm.prank(unauthorized);
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), msgData);

        // Call from mailbox with wrong origin reverts
        vm.expectRevert("Unauthorized: origin domain mismatch");
        vm.prank(address(mailboxA));
        adapterA.handle(9999, address(hubVault).addressToBytes32(), msgData);

        // Call from mailbox with wrong hub sender reverts
        vm.expectRevert("Unauthorized: sender is not Hub vault");
        vm.prank(address(mailboxA));
        adapterA.handle(DOMAIN_HUB, address(unauthorized).addressToBytes32(), msgData);
    }

    function test_AdminFunctionsEnforceOwnerOnly() public {
        vm.expectRevert();
        vm.prank(unauthorized);
        hubVault.pause();

        vm.expectRevert();
        vm.prank(unauthorized);
        hubVault.setStrategy(DOMAIN_A, address(adapterA).addressToBytes32(), 5000);

        vm.expectRevert();
        vm.prank(unauthorized);
        hubVault.setDriftThresholdBps(600);

        vm.expectRevert();
        vm.prank(unauthorized);
        hubVault.setFeeConfig(300, 1500, feeRecipient);

        vm.expectRevert();
        vm.prank(unauthorized);
        adapterA.emergencyUnwind(0);
    }

    // =========================================================================
    // SECTION 9: Emergency Pause and Emergency Unwind Controls
    // =========================================================================

    function test_EmergencyPauseBlocksOperationsAndResumesOnUnpause() public {
        vm.prank(owner);
        hubVault.pause();

        // Deposits blocked
        vm.expectRevert();
        vm.prank(alice);
        hubVault.deposit(1_000e18, alice);

        // Withdrawals blocked
        vm.expectRevert();
        vm.prank(alice);
        hubVault.withdraw(1_000e18, alice, alice);

        // Rebalancing blocked
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 100e18,
            minAmountOut: 90e18,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert();
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0}(orders, 0);

        // Unpause resumes operations
        vm.prank(owner);
        hubVault.unpause();

        vm.prank(alice);
        uint256 shares = hubVault.deposit(1_000e18, alice);
        assertGt(shares, 0);
    }

    function test_EmergencyUnwindRecoversStrategyAssets() public {
        uint256 depositAmount = 5_000e18;
        underlyingAsset.mint(address(adapterA), depositAmount);

        vm.prank(owner);
        adapterA.depositToYieldStrategy(depositAmount, depositAmount);

        assertEq(strategyVaultA.balanceOf(address(adapterA)), depositAmount);

        // Trigger emergency unwind
        vm.prank(owner);
        adapterA.emergencyUnwind(depositAmount);

        // Strategy shares redeemed to 0, underlying asset balance restored in adapter
        assertEq(strategyVaultA.balanceOf(address(adapterA)), 0);
        assertGe(underlyingAsset.balanceOf(address(adapterA)), depositAmount);
    }

    function test_EmergencyTokenRecovery() public {
        MockERC20 stuckToken = new MockERC20("Stuck Token", "STUCK", 18);
        stuckToken.mint(address(adapterA), 500e18);

        vm.prank(owner);
        adapterA.recoverToken(address(stuckToken), owner, 500e18);

        assertEq(stuckToken.balanceOf(owner), 500e18);
        assertEq(stuckToken.balanceOf(address(adapterA)), 0);
    }

    // =========================================================================
    // SECTION 10: Message Codec Unit & Boundary Tests
    // =========================================================================

    function test_CrossChainVaultMessageCodecSerialization() public {
        bytes32 recipient = address(0x1234).addressToBytes32();
        bytes memory encoded = CrossChainVaultMessage.encodeDeposit(
            recipient,
            1_000e18,
            990e18,
            1_700_000_000,
            "extra"
        );

        CrossChainVaultMessage.Message memory decoded = CrossChainVaultMessage.parseMemory(encoded);
        assertEq(decoded.msgType, CrossChainVaultMessage.TYPE_DEPOSIT);
        assertEq(decoded.recipientOrSender, recipient);
        assertEq(decoded.amount, 1_000e18);
        assertEq(decoded.minAmountOut, 990e18);
        assertEq(decoded.deadline, 1_700_000_000);
        assertEq(decoded.extraData, "extra");
    }

    function test_CrossChainVaultMessageCodecRejectsInvalidPayloads() public {
        // Payload too short
        bytes memory shortData = hex"123456";
        vm.expectRevert("Invalid message length: payload too short");
        this.parseMessageExternal(shortData);

        // Unknown message type
        bytes memory invalidTypeData = abi.encode(
            uint8(99),
            address(0x1234).addressToBytes32(),
            uint256(100),
            uint256(100),
            uint256(100),
            bytes("")
        );
        vm.expectRevert("Invalid message type: unknown type identifier");
        this.parseMessageExternal(invalidTypeData);

        // Zero recipient
        bytes memory zeroRecipientData = abi.encode(
            uint8(1),
            bytes32(0),
            uint256(100),
            uint256(100),
            uint256(100),
            bytes("")
        );
        vm.expectRevert("Invalid message: zero recipient or sender");
        this.parseMessageExternal(zeroRecipientData);
    }
}

/**
 * @title MultiChainVaultInvariantTest
 * @notice Invariant and property-based test suite verifying global safety invariants.
 */
contract MultiChainVaultInvariantTest is Test {
    using TypeCasts for address;

    MockHyperlaneEnvironment public env;
    MockERC20 public underlyingAsset;
    MultiChainVaultHub public hubVault;
    MockERC4626YieldSharing public strategyVaultA;
    CrossChainStrategyAdapter public adapterA;

    address public owner = address(0x1111);
    address public feeRecipient = address(0x2222);
    address public user = address(0x3333);

    function setUp() public {
        env = new MockHyperlaneEnvironment();
        underlyingAsset = new MockERC20("Cross-Chain Asset", "XASSET", 18);

        vm.startPrank(owner);
        hubVault = new MultiChainVaultHub(
            underlyingAsset,
            "Hyperlane Multi-Chain Vault",
            "hVAULT",
            address(env.mailboxHub()),
            1000,
            feeRecipient,
            200,
            1000,
            500
        );

        strategyVaultA = new MockERC4626YieldSharing(underlyingAsset, "Renzo Strategy A", "renA");

        adapterA = new CrossChainStrategyAdapter(
            address(env.mailboxSpokeA()),
            1000,
            address(hubVault).addressToBytes32(),
            address(underlyingAsset),
            address(strategyVaultA),
            owner
        );

        hubVault.setStrategy(2000, address(adapterA).addressToBytes32(), 10000);
        vm.stopPrank();

        underlyingAsset.mint(user, 1_000_000e18);
        vm.prank(user);
        underlyingAsset.approve(address(hubVault), type(uint256).max);
    }

    function test_Invariant_TotalPortfolioNavConsistency() public {
        vm.prank(user);
        hubVault.deposit(10_000e18, user);

        uint256 localBal = underlyingAsset.balanceOf(address(hubVault));
        uint256 reportedNav = hubVault.getStrategy(2000).lastReportedNav;

        assertEq(hubVault.totalPortfolioNav(), localBal + reportedNav);
        assertEq(hubVault.totalAssets(), hubVault.totalPortfolioNav());
    }

    function test_Invariant_HighWaterMarkNeverDecreases() public {
        vm.prank(user);
        hubVault.deposit(10_000e18, user);

        uint256 hwm1 = hubVault.highWaterMarkNavPerShare();

        // Gain yield
        underlyingAsset.mint(address(hubVault), 2_000e18);
        hubVault.accrueFees();
        uint256 hwm2 = hubVault.highWaterMarkNavPerShare();
        assertGe(hwm2, hwm1);

        // Loss occurs
        vm.prank(address(hubVault));
        underlyingAsset.burn(address(hubVault), 1_000e18);
        hubVault.accrueFees();
        uint256 hwm3 = hubVault.highWaterMarkNavPerShare();
        assertEq(hwm3, hwm2); // HWM must NOT decrease on loss
    }
}
