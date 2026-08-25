// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MultiChainVaultTest} from "./MultiChainVault.t.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";

contract Tier2_BoundaryTest is MultiChainVaultTest {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ==========================================
    // Feature 8 Boundaries: MultiChainVaultHub (5 tests)
    // ==========================================

    function test_F8_B1_ZeroDepositReturnsZeroShares() public {
        vm.prank(alice);
        uint256 shares = hubVault.deposit(0, alice);
        assertEq(shares, 0);
    }

    function test_F8_B2_InflationDonationAttackDefense() public {
        // Attacker deposits 1 wei
        underlyingAsset.mint(attacker, 100_000e18);
        vm.startPrank(attacker);
        underlyingAsset.approve(address(hubVault), type(uint256).max);
        hubVault.deposit(1, attacker);

        // Attacker donates 10,000 ETH directly to vault
        underlyingAsset.transfer(address(hubVault), 10_000e18);
        vm.stopPrank();

        // Alice deposits 1,000 ETH
        vm.prank(alice);
        uint256 aliceShares = hubVault.deposit(1_000e18, alice);

        // Thanks to virtual offset (3 decimals = +1000 shares & +1 assets virtual):
        // Alice receives substantial shares (> 0) and attacker cannot steal her funds!
        assertGt(aliceShares, 0);

        // Alice can withdraw her fair share
        vm.prank(alice);
        uint256 withdrawn = hubVault.redeem(aliceShares, alice, alice);
        assertGt(withdrawn, 990e18);
    }

    function test_F8_B3_MaxWithdrawalExceedingTotalAssetsReverts() public {
        vm.prank(alice);
        hubVault.deposit(1_000e18, alice);

        vm.prank(alice);
        vm.expectRevert();
        hubVault.withdraw(2_000e18, alice, alice);
    }

    function test_F8_B4_RemoveStrategyWithActiveNavReverts() public {
        // Domain A has 10_000 NAV
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 10_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        vm.prank(owner);
        vm.expectRevert("Strategy has active NAV or allocated assets");
        hubVault.removeStrategy(DOMAIN_A);
    }

    function test_F8_B5_StrategyTotalWeightExceeding10000BpsReverts() public {
        vm.startPrank(owner);
        // Domain A = 5000, Domain B = 5000 in setup. Adding Domain C with 1000 exceeds 10000.
        vm.expectRevert("Total target weight exceeds 10,000 bps");
        hubVault.setStrategy(4000, address(0x4444).addressToBytes32(), 1000);
        vm.stopPrank();
    }

    // ==========================================
    // Feature 9 Boundaries: CrossChainStrategyAdapter (5 tests)
    // ==========================================

    function test_F9_B1_DepositSlippageViolationReverts() public {
        uint256 amount = 1_000e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.prank(owner);
        // minSharesOut higher than 1000e18 will revert
        vm.expectRevert("Slippage: minSharesOut condition violated");
        adapterA.depositToYieldStrategy(amount, 1_100e18);
    }

    function test_F9_B2_WithdrawSlippageViolationReverts() public {
        uint256 amount = 1_000e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.startPrank(owner);
        adapterA.depositToYieldStrategy(amount, 0);

        vm.expectRevert("Slippage: minAssetsOut condition violated");
        adapterA.withdrawFromYieldStrategy(500e18, 600e18);
        vm.stopPrank();
    }

    function test_F9_B3_ZeroDepositOrWithdrawReverts() public {
        vm.startPrank(owner);
        vm.expectRevert("Deposit amount must be greater than zero");
        adapterA.depositToYieldStrategy(0, 0);

        vm.expectRevert("Withdraw amount must be greater than zero");
        adapterA.withdrawFromYieldStrategy(0, 0);
        vm.stopPrank();
    }

    function test_F9_B4_WithdrawExceedingHoldingReverts() public {
        uint256 amount = 500e18;
        underlyingAsset.mint(address(adapterA), amount);

        vm.startPrank(owner);
        adapterA.depositToYieldStrategy(amount, 0);

        vm.expectRevert("Insufficient strategy assets for withdrawal");
        adapterA.withdrawFromYieldStrategy(1_000e18, 0);
        vm.stopPrank();
    }

    function test_F9_B5_SyncNavZeroValueDispatchesSuccessfully() public {
        // NAV is 0
        vm.prank(owner);
        adapterA.syncNavToHub{value: 0.05 ether}(0.05 ether);

        assertEq(mailboxA.nonceCounter(), 1);
    }

    // ==========================================
    // Feature 10 Boundaries: CrossChainVaultMessage (5 tests)
    // ==========================================

    function test_F10_B1_ParsePayloadTooShortReverts() public {
        bytes memory shortPayload = hex"01020304";

        vm.expectRevert("Invalid message length: payload too short");
        this.parseMessageExternal(shortPayload);
    }

    function test_F10_B2_InvalidMessageTypeReverts() public {
        // msgType = 0
        CrossChainVaultMessage.Message memory invalidMsg = CrossChainVaultMessage.Message({
            msgType: 0,
            recipientOrSender: alice.addressToBytes32(),
            amount: 100e18,
            minAmountOut: 0,
            deadline: block.timestamp,
            extraData: ""
        });

        bytes memory raw = abi.encode(
            invalidMsg.msgType,
            invalidMsg.recipientOrSender,
            invalidMsg.amount,
            invalidMsg.minAmountOut,
            invalidMsg.deadline,
            invalidMsg.extraData
        );

        vm.expectRevert("Invalid message type: unknown type identifier");
        this.parseMessageExternal(raw);
    }

    function test_F10_B3_ZeroRecipientOrSenderReverts() public {
        CrossChainVaultMessage.Message memory zeroRecipientMsg = CrossChainVaultMessage.Message({
            msgType: CrossChainVaultMessage.TYPE_DEPOSIT,
            recipientOrSender: bytes32(0),
            amount: 100e18,
            minAmountOut: 0,
            deadline: block.timestamp,
            extraData: ""
        });

        bytes memory raw = abi.encode(
            zeroRecipientMsg.msgType,
            zeroRecipientMsg.recipientOrSender,
            zeroRecipientMsg.amount,
            zeroRecipientMsg.minAmountOut,
            zeroRecipientMsg.deadline,
            zeroRecipientMsg.extraData
        );

        vm.expectRevert("Invalid message: zero recipient or sender");
        this.parseMessageExternal(raw);
    }

    function test_F10_B4_EmptyExtraDataEncoding() public {
        bytes memory encoded = CrossChainVaultMessage.encodeDeposit(
            alice.addressToBytes32(),
            500e18,
            490e18,
            block.timestamp + 100,
            ""
        );

        CrossChainVaultMessage.Message memory parsed = CrossChainVaultMessage.parseMemory(encoded);
        assertEq(parsed.extraData.length, 0);
    }

    function test_F10_B5_LargeExtraDataEncoding() public {
        bytes memory largeData = new bytes(1024);
        for (uint256 i = 0; i < 1024; i++) {
            largeData[i] = bytes1(uint8(i % 256));
        }

        bytes memory encoded = CrossChainVaultMessage.encodeDeposit(
            alice.addressToBytes32(),
            500e18,
            490e18,
            block.timestamp + 100,
            largeData
        );

        CrossChainVaultMessage.Message memory parsed = CrossChainVaultMessage.parseMemory(encoded);
        assertEq(parsed.extraData.length, 1024);
        assertEq(parsed.extraData, largeData);
    }

    // ==========================================
    // Feature 11 Boundaries: VaultRebalanceEngine (5 tests)
    // ==========================================

    function test_F11_B1_EmptyRebalanceOrdersReverts() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](0);

        vm.prank(owner);
        vm.expectRevert("No rebalance orders provided");
        hubVault.triggerRebalance(orders, 0);
    }

    function test_F11_B2_RebalanceOrderUnregisteredSourceDomainReverts() public {
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: 9999, // Unregistered domain
            targetDomain: DOMAIN_B,
            amount: 1_000e18,
            minAmountOut: 900e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        vm.expectRevert("Source strategy domain not registered");
        hubVault.triggerRebalance(orders, 0);
    }

    function test_F11_B3_RebalanceOrderUnregisteredTargetDomainReverts() public {
        // Make sure Domain A has NAV
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 10_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: 8888, // Unregistered target
            amount: 1_000e18,
            minAmountOut: 900e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        vm.expectRevert("Target strategy domain not registered");
        hubVault.triggerRebalance(orders, 0);
    }

    function test_F11_B4_RebalanceOrderExceedingStrategyNavReverts() public {
        // Domain A has 5_000 NAV
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 5_000e18, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_A,
            targetDomain: DOMAIN_B,
            amount: 10_000e18, // Exceeds 5k NAV
            minAmountOut: 9_000e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        vm.expectRevert("Source strategy NAV insufficient for rebalance");
        hubVault.triggerRebalance(orders, 0);
    }

    function test_F11_B5_RebalanceOrderInsufficientHubLiquidityReverts() public {
        // Hub local asset is 0
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: DOMAIN_HUB, // Local Hub
            targetDomain: DOMAIN_B,
            amount: 10_000e18,
            minAmountOut: 9_000e18,
            deadline: block.timestamp + 3600
        });

        vm.prank(owner);
        vm.expectRevert("Insufficient Hub local assets for rebalance");
        hubVault.triggerRebalance(orders, 0);
    }

    // ==========================================
    // Feature 12 Boundaries: MailboxSecurityAndAuth (5 tests)
    // ==========================================

    function test_F12_B1_DirectCallToHandleReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 1_000e18, block.timestamp, "");

        vm.prank(alice);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);
    }

    function test_F12_B2_FakeMailboxCallReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 1_000e18, block.timestamp, "");

        vm.prank(address(0xFA11)); // Fake mailbox
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgData);
    }

    function test_F12_B3_SpoofedOriginDomainReverts() public {
        bytes memory msgData = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 1_000e18, block.timestamp, "");

        // From real mailbox, but unknown origin domain 7777
        vm.prank(address(mailboxHub));
        vm.expectRevert("Unauthorized: origin domain not registered");
        hubVault.handle(7777, address(adapterA).addressToBytes32(), msgData);
    }

    function test_F12_B4_PausedContractBlocksDepositsAndWithdrawals() public {
        vm.prank(owner);
        hubVault.pause();

        vm.prank(alice);
        vm.expectRevert();
        hubVault.deposit(100e18, alice);

        vm.prank(owner);
        hubVault.unpause();

        vm.prank(alice);
        uint256 shares = hubVault.deposit(100e18, alice);
        assertGt(shares, 0);
    }

    function test_F12_B5_EmergencyUnwindAllowedFromMailboxOrOwnerOnly() public {
        vm.prank(attacker);
        vm.expectRevert("Unauthorized emergency unwind caller");
        adapterA.emergencyUnwind(0);
    }

    // ==========================================
    // Feature 13 Boundaries: FeeAccrualAndAccounting (5 tests)
    // ==========================================

    function test_F13_B1_ZeroFeesWhenFeesConfiguredToZero() public {
        vm.startPrank(owner);
        hubVault.setFeeConfig(0, 0, feeRecipient);
        vm.stopPrank();

        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        vm.warp(block.timestamp + 3650 days); // 10 years

        hubVault.accrueFees();
        assertEq(hubVault.balanceOf(feeRecipient), 0);
    }

    function test_F13_B2_AccrueFeesCalledMultipleTimesInSameBlock() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        vm.warp(block.timestamp + 365 days);

        hubVault.accrueFees();
        uint256 firstShares = hubVault.balanceOf(feeRecipient);
        assertGt(firstShares, 0);

        hubVault.accrueFees();
        hubVault.accrueFees();

        uint256 afterShares = hubVault.balanceOf(feeRecipient);
        assertEq(afterShares, firstShares, "Subsequent calls in same timestamp must not mint additional shares");
    }

    function test_F13_B3_PerformanceFeeCalculationRounding() public {
        vm.prank(alice);
        hubVault.deposit(1_000_000e18, alice);

        // Report tiny 1-wei profit
        bytes memory msgA = CrossChainVaultMessage.encodeNavReport(address(adapterA).addressToBytes32(), 1_000_000e18 + 1, block.timestamp, "");
        vm.prank(address(mailboxHub));
        hubVault.handle(DOMAIN_A, address(adapterA).addressToBytes32(), msgA);

        // Should not throw and should handle 1-wei profit calculation gracefully
        hubVault.accrueFees();
    }

    function test_F13_B4_FeeRecipientUpdateTakesEffectImmediately() public {
        address newFeeRecipient = address(0x7777);

        vm.prank(owner);
        hubVault.setFeeConfig(200, 1000, newFeeRecipient);

        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        vm.warp(block.timestamp + 365 days);
        hubVault.accrueFees();

        assertEq(hubVault.balanceOf(feeRecipient), 0);
        assertGt(hubVault.balanceOf(newFeeRecipient), 0);
    }

    function test_F13_B5_FeeSharesDoNotDiluteUnderlyingNavAssets() public {
        vm.prank(alice);
        hubVault.deposit(100_000e18, alice);

        uint256 navBefore = hubVault.totalPortfolioNav();

        vm.warp(block.timestamp + 365 days);
        hubVault.accrueFees();

        uint256 navAfter = hubVault.totalPortfolioNav();
        assertEq(navAfter, navBefore, "Fee shares must not change total underlying portfolio assets");
    }
}
