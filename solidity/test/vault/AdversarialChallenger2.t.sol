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
 * @title AdversarialChallenger2Test
 * @notice Empirical Adversarial Stress Suite for Hyperlane Multi-Chain Vault.
 * Stress-tests:
 * 1. ERC-4626 virtual offset & 1-wei share inflation attacks with extreme donation amounts.
 * 2. Multi-domain drift math, rebalancing with slippage, deadline expiration, and liquidity bounds.
 * 3. Two-layer Mailbox authorization against domain spoofing, fake mailboxes, and forged payloads.
 * 4. High-Water Mark fee mechanics across extreme bear drawdowns, recoveries, and new all-time highs.
 */
contract AdversarialChallenger2Test is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    address public owner = address(0x1111);
    address public feeRecipient = address(0x2222);
    address public alice = address(0xAAAA);
    address public bob = address(0xBBBB);
    address public attacker = address(0xDEAD);
    address public fakeMailbox = address(0xFA11);

    MockHyperlaneEnvironment public env;
    MockMailbox public mailboxHub;
    MockMailbox public mailboxA;
    MockMailbox public mailboxB;

    MockERC20 public underlyingAsset;
    MultiChainVaultHub public hubVault;
    MockERC4626YieldSharing public strategyVaultA;
    MockERC4626YieldSharing public strategyVaultB;
    CrossChainStrategyAdapter public adapterA;
    CrossChainStrategyAdapter public adapterB;

    uint32 public constant DOMAIN_HUB = 1000;
    uint32 public constant DOMAIN_A = 2000;
    uint32 public constant DOMAIN_B = 3000;

    function setUp() public {
        vm.warp(1_700_000_000);

        env = new MockHyperlaneEnvironment();
        mailboxHub = env.mailboxHub();
        mailboxA = env.mailboxSpokeA();
        mailboxB = env.mailboxSpokeB();

        underlyingAsset = new MockERC20("Cross-Chain Asset", "XASSET", 18);

        vm.startPrank(owner);
        hubVault = new MultiChainVaultHub(
            underlyingAsset,
            "Hyperlane Multi-Chain Vault",
            "hVAULT",
            address(mailboxHub),
            DOMAIN_HUB,
            feeRecipient,
            200, // 2% per annum
            1000, // 10% performance fee
            500 // 5% drift threshold
        );

        strategyVaultA = new MockERC4626YieldSharing(underlyingAsset, "Renzo Strategy A", "renA");
        strategyVaultB = new MockERC4626YieldSharing(underlyingAsset, "Pendle Strategy B", "penB");

        adapterA = new CrossChainStrategyAdapter(
            address(mailboxA),
            DOMAIN_HUB,
            address(hubVault).addressToBytes32(),
            address(underlyingAsset),
            address(strategyVaultA),
            owner
        );

        adapterB = new CrossChainStrategyAdapter(
            address(mailboxB),
            DOMAIN_HUB,
            address(hubVault).addressToBytes32(),
            address(underlyingAsset),
            address(strategyVaultB),
            owner
        );

        hubVault.setStrategy(DOMAIN_A, address(adapterA).addressToBytes32(), 5000);
        hubVault.setStrategy(DOMAIN_B, address(adapterB).addressToBytes32(), 5000);
        vm.stopPrank();

        underlyingAsset.mint(alice, 10_000_000e18);
        underlyingAsset.mint(bob, 10_000_000e18);
        underlyingAsset.mint(attacker, 10_000_000e18);

        vm.prank(alice);
        underlyingAsset.approve(address(hubVault), type(uint256).max);
        vm.prank(bob);
        underlyingAsset.approve(address(hubVault), type(uint256).max);
        vm.prank(attacker);
        underlyingAsset.approve(address(hubVault), type(uint256).max);

        vm.deal(owner, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(attacker, 100 ether);
        vm.deal(address(adapterA), 100 ether);
        vm.deal(address(adapterB), 100 ether);
    }

    // =========================================================================
    // 1. ERC-4626 VIRTUAL OFFSET & ADVERSARIAL INFLATION ATTACKS
    // =========================================================================

    function test_Adversarial_ExtremeDonationInflationAttack() public {
        // Attacker deposits minimal 1 wei
        vm.prank(attacker);
        uint256 attackerShares = hubVault.deposit(1, attacker);
        assertEq(attackerShares, 1000, "1 wei deposit should yield 1000 shares with 10^3 virtual offset");

        // Attacker donates 1,000,000 tokens (1e24 wei) directly to the vault
        uint256 massiveDonation = 1_000_000e18;
        vm.prank(attacker);
        underlyingAsset.transfer(address(hubVault), massiveDonation);

        // Victim deposits standard amount: 500 tokens (500e18)
        uint256 victimDeposit = 500e18;
        vm.prank(alice);
        uint256 victimShares = hubVault.deposit(victimDeposit, alice);

        // Without virtual offset, victimShares would be 0 (100% loss).
        // With virtual offset, victimShares MUST be > 0
        assertTrue(victimShares > 0, "Victim must receive non-zero shares despite massive inflation donation");

        // Victim immediately redeems
        vm.prank(alice);
        uint256 victimRedeemed = hubVault.redeem(victimShares, alice, alice);

        // Victim retains the vast majority (>90%) of their deposit
        assertApproxEqRel(victimRedeemed, victimDeposit, 0.10e18);

        // Attacker redeems their 1000 shares
        vm.prank(attacker);
        uint256 attackerRedeemed = hubVault.redeem(attackerShares, attacker, attacker);

        // Attacker loses >500,000 tokens (over 50% of donation) making the attack massively negative EV
        assertTrue(attackerRedeemed < massiveDonation / 2, "Attacker suffers massive loss");
    }

    function test_Adversarial_SequentialMicroDepositsAndDonations() public {
        // Interspersed micro-donations and deposits
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(attacker);
            hubVault.deposit(100 + i, attacker);

            vm.prank(attacker);
            underlyingAsset.transfer(address(hubVault), 10_000e18);

            vm.prank(alice);
            uint256 aliceShares = hubVault.deposit(1_000e18, alice);
            assertTrue(aliceShares > 0, "Alice must always receive shares");
        }

        // Alice redeems all shares
        uint256 aliceTotalShares = hubVault.balanceOf(alice);
        vm.prank(alice);
        uint256 aliceRecovered = hubVault.redeem(aliceTotalShares, alice, alice);
        assertTrue(aliceRecovered > 4_500e18, "Alice recovers the vast majority of her deposit");
    }

    // =========================================================================
    // 2. MULTI-DOMAIN DRIFT & REBALANCE STRESS TESTING
    // =========================================================================

    function test_Adversarial_DriftCalculationWithZeroAndExtremeAllocations() public {
        // Zero portfolio NAV should return 0 drift and false
        (uint256 drift0, bool rebalance0) = hubVault.calculateDrift();
        assertEq(drift0, 0);
        assertFalse(rebalance0);

        // Spoke A reports 100k, Spoke B reports 0 (Target is 50k / 50k = 50% each)
        // Spoke A weight = 100%, drift = 50% (5000 bps)
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 100_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        (uint256 drift1, bool rebalance1) = hubVault.calculateDrift();
        assertEq(drift1, 5000, "Drift should be exactly 5000 bps (50%)");
        assertTrue(rebalance1, "Should require rebalance at 50% drift");
    }

    function test_Adversarial_RebalanceOrderValidationEdgeCases() public {
        // 1. Rebalance with order amount > reported strategy NAV should revert
        IMultiChainVaultHub.RebalanceOrder[] memory ordersOver = new IMultiChainVaultHub.RebalanceOrder[](1);
        ordersOver[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 50_000e18,
            minAmountOut: 49_000e18,
            deadline: block.timestamp + 3600
        });

        // Strategy A currently has 0 NAV reported
        vm.expectRevert("Source strategy NAV insufficient for rebalance");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.1 ether}(ordersOver, 0.05 ether);

        // 2. Rebalance from Hub local with insufficient local assets should revert
        IMultiChainVaultHub.RebalanceOrder[] memory ordersHubOver = new IMultiChainVaultHub.RebalanceOrder[](1);
        ordersHubOver[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_HUB,
            targetDomain: DOMAIN_A,
            amount: 50_000e18,
            minAmountOut: 49_000e18,
            deadline: block.timestamp + 3600
        });

        vm.expectRevert("Insufficient Hub local assets for rebalance");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.1 ether}(ordersHubOver, 0.05 ether);

        // 3. Rebalance with zero amount should revert
        underlyingAsset.mint(address(hubVault), 10_000e18);
        IMultiChainVaultHub.RebalanceOrder[] memory ordersZero = new IMultiChainVaultHub.RebalanceOrder[](1);
        ordersZero[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_HUB,
            targetDomain: DOMAIN_A,
            amount: 0,
            minAmountOut: 990e18,
            deadline: block.timestamp + 3600
        });

        vm.expectRevert("Rebalance amount must be greater than zero");
        vm.prank(owner);
        hubVault.triggerRebalance{value: 0.1 ether}(ordersZero, 0.05 ether);
    }

    function test_Adversarial_StrategyRegistrationWeightsBoundary() public {
        // Exceeding 10,000 bps total weight across strategies must revert
        vm.startPrank(owner);
        vm.expectRevert("Total target weight exceeds 10,000 bps");
        hubVault.setStrategy(9999, address(0x9999).addressToBytes32(), 1); // 5000 + 5000 + 1 = 10001
        vm.stopPrank();
    }

    function test_Adversarial_CannotRemoveActiveStrategy() public {
        // Report active NAV on Spoke A
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 10_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        // Owner attempts to remove Spoke A while it has active NAV -> Must revert
        vm.prank(owner);
        vm.expectRevert("Strategy has active NAV or allocated assets");
        hubVault.removeStrategy(DOMAIN_A);
    }

    // =========================================================================
    // 3. TWO-LAYER MAILBOX AUTHORIZATION & ADVERSARIAL ATTACKS
    // =========================================================================

    function test_Adversarial_DirectEOACallToHubHandleReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            50_000e18,
            block.timestamp + 3600,
            ""
        );

        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);
    }

    function test_Adversarial_FakeMailboxCallToHubHandleReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            50_000e18,
            block.timestamp + 3600,
            ""
        );

        vm.prank(fakeMailbox);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);
    }

    function test_Adversarial_SpoofedOriginDomainReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            50_000e18,
            block.timestamp + 3600,
            ""
        );

        // Real mailbox caller, but origin domain 9999 is unlisted
        vm.prank(address(mailboxHub));
        vm.expectRevert("Unauthorized: origin domain not registered");
        hubVault.handle(9999, address(adapterA).addressToBytes32(), msgData);
    }

    function test_Adversarial_SpoofedSenderAdapterReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(
            address(attacker).addressToBytes32(),
            50_000e18,
            block.timestamp + 3600,
            ""
        );

        // Real mailbox caller and registered domain DOMAIN_A, but sender is attacker instead of adapterA
        vm.prank(address(mailboxHub));
        vm.expectRevert("Unauthorized: sender adapter mismatch");
        hubVault.handle(DOMAIN_A, address(attacker).addressToBytes32(), msgData);
    }

    function test_Adversarial_AdapterRejectsFakeMailboxAndSpoofedHub() public {
        bytes memory depositMsg = CrossChainVaultMessage.encodeDeposit(
            address(adapterA).addressToBytes32(),
            10_000e18,
            9_900e18,
            block.timestamp + 3600,
            ""
        );

        // Direct EOA call to adapter
        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), depositMsg);

        // Fake Mailbox to adapter
        vm.prank(fakeMailbox);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        adapterA.handle(DOMAIN_HUB, address(hubVault).addressToBytes32(), depositMsg);

        // Real mailbox but fake hub sender
        vm.prank(address(mailboxA));
        vm.expectRevert("Unauthorized: sender is not Hub vault");
        adapterA.handle(DOMAIN_HUB, address(attacker).addressToBytes32(), depositMsg);

        // Real mailbox but wrong origin domain
        vm.prank(address(mailboxA));
        vm.expectRevert("Unauthorized: origin domain mismatch");
        adapterA.handle(DOMAIN_B, address(hubVault).addressToBytes32(), depositMsg);
    }

    function test_Adversarial_ExpiredCrossChainMessageReverts() public {
        bytes memory expiredMsg = CrossChainVaultMessage.encodeNavReport(
            address(adapterA).addressToBytes32(),
            50_000e18,
            block.timestamp - 1, // Expired deadline
            ""
        );

        vm.prank(address(mailboxHub));
        vm.expectRevert("Received message expired");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), expiredMsg);
    }

    // =========================================================================
    // 4. HIGH-WATER MARK FEE STRESS TESTING (DRAWDOWNS, RECOVERIES, ATHS)
    // =========================================================================

    function test_Adversarial_HwmDrawdownAndVShapedRecovery() public {
        // Alice deposits 100,000 tokens
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        uint256 initialHwm = hubVault.highWaterMarkNavPerShare();
        assertEq(initialHwm, 1e18);

        // Period 1: Profit of +50,000 tokens (NAV = 150,000)
        underlyingAsset.mint(address(hubVault), 50_000e18);
        hubVault.accrueFees();

        uint256 hwmPeak = hubVault.highWaterMarkNavPerShare();
        assertTrue(hwmPeak > initialHwm, "HWM must increase on profit");
        uint256 feeShares1 = hubVault.balanceOf(feeRecipient);
        assertTrue(feeShares1 > 0, "Performance fee shares must be minted on profit");

        // Period 2: Severe market crash (-80,000 tokens) -> NAV drops to ~70,000
        vm.prank(address(hubVault));
        underlyingAsset.burn(address(hubVault), 80_000e18);

        hubVault.accrueFees();
        // HWM must NOT decrease
        assertEq(hubVault.highWaterMarkNavPerShare(), hwmPeak, "HWM must remain at peak during crash");
        // Fee shares for fee recipient should not change from performance fees (only tiny time-based mgmt fee if any)
        uint256 feeSharesCrash = hubVault.balanceOf(feeRecipient);
        assertApproxEqAbs(feeSharesCrash, feeShares1, 1e18);

        // Period 3: Recovery to 130,000 tokens (still below previous peak of 150,000)
        underlyingAsset.mint(address(hubVault), 60_000e18);
        hubVault.accrueFees();

        // Still NO performance fee because NAV per share is below HWM
        assertEq(hubVault.highWaterMarkNavPerShare(), hwmPeak, "HWM must remain unchanged below peak");
        uint256 feeSharesRecovery = hubVault.balanceOf(feeRecipient);
        assertApproxEqAbs(feeSharesRecovery, feeSharesCrash, 1e18);

        // Period 4: New All-Time High to 200,000 tokens (+50,000 above peak)
        underlyingAsset.mint(address(hubVault), 70_000e18);
        hubVault.accrueFees();

        // Performance fee resumes and HWM increases to new peak
        uint256 hwmNewPeak = hubVault.highWaterMarkNavPerShare();
        assertTrue(hwmNewPeak > hwmPeak, "HWM must increase to new ATH");
        uint256 feeSharesAth = hubVault.balanceOf(feeRecipient);
        assertTrue(feeSharesAth > feeSharesRecovery, "Performance fee accrued on new ATH gains");
    }

    function test_Adversarial_ZeroFeeAccrualWhenConfiguredToZero() public {
        // Set both fees to 0
        vm.prank(owner);
        hubVault.setFeeConfig(0, 0, feeRecipient);

        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        // Time passes (10 years) + massive yield
        vm.warp(block.timestamp + 3650 days);
        underlyingAsset.mint(address(hubVault), 1_000_000e18);

        hubVault.accrueFees();

        assertEq(hubVault.balanceOf(feeRecipient), 0, "Zero fees configured must yield 0 fee shares");
    }

    function test_Adversarial_FeeRecipientUpdate() public {
        address newFeeRecipient = address(0x7777);

        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        vm.prank(owner);
        hubVault.setFeeConfig(200, 1000, newFeeRecipient);

        // Gain yield
        underlyingAsset.mint(address(hubVault), 20_000e18);
        hubVault.accrueFees();

        assertEq(hubVault.balanceOf(feeRecipient), 0, "Old recipient gets no fees");
        assertTrue(hubVault.balanceOf(newFeeRecipient) > 0, "New recipient receives fee shares");
    }
}
