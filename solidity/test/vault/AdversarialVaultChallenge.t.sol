// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MultiChainVaultHub} from "../../contracts/vault/MultiChainVaultHub.sol";
import {IMultiChainVaultHub} from "../../contracts/interfaces/IMultiChainVaultHub.sol";
import {CrossChainStrategyAdapter} from "../../contracts/vault/CrossChainStrategyAdapter.sol";
import {CrossChainVaultMessage} from "../../contracts/vault/libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "../../contracts/vault/libs/TypeCasts.sol";
import {MockERC20} from "../../contracts/mock/MockERC20.sol";
import {MockERC4626YieldSharing} from "../../contracts/mock/MockERC4626YieldSharing.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";

contract AdversarialVaultChallengeTest is Test {
    MockHyperlaneEnvironment public env;
    MultiChainVaultHub public hub;
    CrossChainStrategyAdapter public adapterA;
    CrossChainStrategyAdapter public adapterB;
    MockERC20 public underlying;
    MockERC4626YieldSharing public yieldVaultA;
    MockERC4626YieldSharing public yieldVaultB;

    address public owner = address(0xABCD);
    address public attacker = address(0xBAD);
    address public victim = address(0x1111);
    address public feeRecipient = address(0xFEE);

    uint32 public constant HUB_DOMAIN = 1000;
    uint32 public constant SPOKE_A_DOMAIN = 2000;
    uint32 public constant SPOKE_B_DOMAIN = 3000;

    function setUp() public {
        vm.startPrank(owner);
        env = new MockHyperlaneEnvironment();
        underlying = new MockERC20("Cross-Chain Asset", "XASSET", 18);
        yieldVaultA = new MockERC4626YieldSharing(underlying, "Renzo Strategy A", "renA");
        yieldVaultB = new MockERC4626YieldSharing(underlying, "Pendle Strategy B", "penB");

        hub = new MultiChainVaultHub(
            underlying,
            "Hyperlane Multi-Chain Vault",
            "hVAULT",
            address(env.mailboxHub()),
            HUB_DOMAIN,
            feeRecipient,
            200,
            1000,
            500
        );

        adapterA = new CrossChainStrategyAdapter(
            address(env.mailboxSpokeA()),
            HUB_DOMAIN,
            TypeCasts.addressToBytes32(address(hub)),
            address(underlying),
            address(yieldVaultA),
            owner
        );

        adapterB = new CrossChainStrategyAdapter(
            address(env.mailboxSpokeB()),
            HUB_DOMAIN,
            TypeCasts.addressToBytes32(address(hub)),
            address(underlying),
            address(yieldVaultB),
            owner
        );

        hub.setStrategy(SPOKE_A_DOMAIN, TypeCasts.addressToBytes32(address(adapterA)), 4000);
        hub.setStrategy(SPOKE_B_DOMAIN, TypeCasts.addressToBytes32(address(adapterB)), 4000);

        // Mint initial tokens and ETH
        underlying.mint(victim, 1000 ether);
        underlying.mint(attacker, 1000 ether);
        underlying.mint(owner, 1000 ether);
        vm.deal(owner, 100 ether);
        vm.deal(victim, 10 ether);
        vm.deal(attacker, 10 ether);
        vm.stopPrank();

        vm.prank(victim);
        underlying.approve(address(hub), type(uint256).max);

        vm.prank(attacker);
        underlying.approve(address(hub), type(uint256).max);
    }

    // =========================================================================
    // 1. INFLATION ATTACK & VIRTUAL OFFSET ADVERSARIAL STRESS
    // =========================================================================

    function test_ADV_InflationAttack_DonationFrontrunningDefended() public {
        // Step 1: Attacker deposits 1 wei into empty vault
        vm.prank(attacker);
        uint256 attackerShares = hub.deposit(1, attacker);
        // With virtual offset of 3, 1 wei mints 1000 shares (due to virtual offset 10^3)
        assertGt(attackerShares, 0);

        // Step 2: Attacker donates 100 ether directly to vault to skew share price
        vm.prank(attacker);
        underlying.transfer(address(hub), 100 ether);

        // Step 3: Victim deposits 10 ether
        vm.prank(victim);
        uint256 victimShares = hub.deposit(10 ether, victim);

        // Verify victim receives substantial non-zero shares (not rounded down to 0)
        assertGt(victimShares, 0);

        // Step 4: Victim withdraws their deposit
        vm.prank(victim);
        uint256 assetsReceived = hub.redeem(victimShares, victim, victim);

        // Victim recovers virtually all assets (loss bounded to negligible rounding)
        assertApproxEqAbs(assetsReceived, 10 ether, 0.5 ether);
    }

    // =========================================================================
    // 2. CROSS-CHAIN MAILBOX AUTHENTICATION & MESSAGE SPOOFING ATTACKS
    // =========================================================================

    function test_ADV_DirectHandleCallByAttackerReverts() public {
        bytes memory msgPayload = CrossChainVaultMessage.encodeNavReport(
            TypeCasts.addressToBytes32(address(adapterA)),
            500 ether,
            block.timestamp + 1 hours,
            ""
        );

        vm.prank(attacker);
        vm.expectRevert("Unauthorized: caller is not Mailbox");
        hub.handle(SPOKE_A_DOMAIN, TypeCasts.addressToBytes32(address(adapterA)), msgPayload);
    }

    function test_ADV_SpoofedOriginDomainReverts() public {
        MockMailbox mailbox = env.mailboxHub();
        bytes memory msgPayload = CrossChainVaultMessage.encodeNavReport(
            TypeCasts.addressToBytes32(address(adapterA)),
            500 ether,
            block.timestamp + 1 hours,
            ""
        );

        uint32 unregisteredDomain = 9999;

        vm.prank(address(mailbox));
        vm.expectRevert("Unauthorized: origin domain not registered");
        hub.handle(unregisteredDomain, TypeCasts.addressToBytes32(address(adapterA)), msgPayload);
    }

    function test_ADV_SpoofedAdapterSenderReverts() public {
        MockMailbox mailbox = env.mailboxHub();
        bytes memory msgPayload = CrossChainVaultMessage.encodeNavReport(
            TypeCasts.addressToBytes32(attacker),
            500 ether,
            block.timestamp + 1 hours,
            ""
        );

        vm.prank(address(mailbox));
        vm.expectRevert("Unauthorized: sender adapter mismatch");
        hub.handle(SPOKE_A_DOMAIN, TypeCasts.addressToBytes32(attacker), msgPayload);
    }

    function test_ADV_ExpiredMessageReverts() public {
        MockMailbox mailbox = env.mailboxHub();
        // Deadline in the past
        bytes memory msgPayload = CrossChainVaultMessage.encodeNavReport(
            TypeCasts.addressToBytes32(address(adapterA)),
            500 ether,
            block.timestamp - 1,
            ""
        );

        vm.prank(address(mailbox));
        vm.expectRevert("Received message expired");
        hub.handle(SPOKE_A_DOMAIN, TypeCasts.addressToBytes32(address(adapterA)), msgPayload);
    }

    // =========================================================================
    // 3. REBALANCING & DRIFT STRESS UNDER BOUNDARY LIQUIDITY
    // =========================================================================

    function test_ADV_RebalanceOrderExceedingStrategyNavReverts() public {
        // Victim deposits 100 ether
        vm.prank(victim);
        hub.deposit(100 ether, victim);

        // Spoke A reported NAV is 0
        IMultiChainVaultHub.RebalanceOrder[] memory orders = new IMultiChainVaultHub.RebalanceOrder[](1);
        orders[0] = IMultiChainVaultHub.RebalanceOrder({
            sourceDomain: SPOKE_A_DOMAIN,
            targetDomain: SPOKE_B_DOMAIN,
            amount: 50 ether,
            minAmountOut: 49 ether,
            deadline: block.timestamp + 1 hours
        });

        vm.prank(owner);
        vm.expectRevert("Source strategy NAV insufficient for rebalance");
        hub.triggerRebalance{value: 0.01 ether}(orders, 0.01 ether);
    }

    function test_ADV_TargetWeightExceeding100PercentReverts() public {
        vm.startPrank(owner);
        // Spoke A is 4000 bps, Spoke B is 4000 bps. Setting Spoke A to 7000 bps -> 7000 + 4000 = 11000 bps > 10000 bps
        vm.expectRevert("Total target weight exceeds 10,000 bps");
        hub.setStrategy(SPOKE_A_DOMAIN, TypeCasts.addressToBytes32(address(adapterA)), 7000);
        vm.stopPrank();
    }

    // =========================================================================
    // 4. HIGH-WATER MARK & PERFORMANCE FEE MARKET CYCLE INTEGRITY
    // =========================================================================

    function test_ADV_HighWaterMarkNoDoubleChargingOnDrawdownAndRecovery() public {
        // 1. Initial deposit: Victim deposits 100 ETH
        vm.prank(victim);
        hub.deposit(100 ether, victim);

        uint256 initialHWM = hub.highWaterMarkNavPerShare();

        // 2. Bull Market: NAV increases by 50 ETH (50% profit)
        vm.prank(owner);
        hub.reportStrategyNav(SPOKE_A_DOMAIN, 50 ether);

        uint256 feeSharesBefore = hub.balanceOf(feeRecipient);
        hub.accrueFees();
        uint256 feeSharesAfterBull = hub.balanceOf(feeRecipient);

        // Performance fee accrued on 50 ETH profit
        assertGt(feeSharesAfterBull, feeSharesBefore);
        uint256 bullHWM = hub.highWaterMarkNavPerShare();
        assertGt(bullHWM, initialHWM);

        // 3. Bear Market Drawdown: Spoke A NAV drops to 10 ETH (40 ETH loss)
        vm.prank(owner);
        hub.reportStrategyNav(SPOKE_A_DOMAIN, 10 ether);

        hub.accrueFees();
        uint256 feeSharesAfterBear = hub.balanceOf(feeRecipient);
        // Zero performance fee during drawdown
        assertEq(feeSharesAfterBear, feeSharesAfterBull);
        // HWM remains ratchet-locked at peak
        assertEq(hub.highWaterMarkNavPerShare(), bullHWM);

        // 4. Partial Recovery: Spoke A NAV recovers to 40 ETH (still below prior 50 ETH peak)
        vm.prank(owner);
        hub.reportStrategyNav(SPOKE_A_DOMAIN, 40 ether);

        hub.accrueFees();
        // Still zero performance fee because NAV is below HWM
        assertEq(hub.balanceOf(feeRecipient), feeSharesAfterBear);

        // 5. New All-Time-High: Spoke A NAV jumps to 80 ETH (30 ETH above previous 50 ETH peak)
        vm.prank(owner);
        hub.reportStrategyNav(SPOKE_A_DOMAIN, 80 ether);

        hub.accrueFees();
        uint256 feeSharesAfterATH = hub.balanceOf(feeRecipient);
        // Fee accrued ONLY on the incremental profit above the previous HWM
        assertGt(feeSharesAfterATH, feeSharesAfterBear);
        assertGt(hub.highWaterMarkNavPerShare(), bullHWM);
    }

    function test_ADV_AccrueFeesMultipleCallsInSameBlockIdempotent() public {
        vm.prank(victim);
        hub.deposit(50 ether, victim);

        // Call accrueFees 10 times in the same block
        uint256 initialTotalSupply = hub.totalSupply();
        for (uint256 i = 0; i < 10; i++) {
            hub.accrueFees();
        }
        // Total supply does not change when elapsed time is 0 and NAV has not changed
        assertEq(hub.totalSupply(), initialTotalSupply);
    }

    // =========================================================================
    // 5. EMERGENCY PAUSE & SLIPPAGE TOLERANCE UNDER ATTACK
    // =========================================================================

    function test_ADV_EmergencyPauseBlocksDepositsAndWithdrawals() public {
        vm.prank(victim);
        hub.deposit(10 ether, victim);

        // Owner pauses vault
        vm.prank(owner);
        hub.pause();

        // Deposits revert when paused
        vm.prank(victim);
        vm.expectRevert();
        hub.deposit(10 ether, victim);

        // Withdrawals revert when paused
        vm.prank(victim);
        vm.expectRevert();
        hub.withdraw(5 ether, victim, victim);

        // Unpause restores functionality
        vm.prank(owner);
        hub.unpause();

        vm.prank(victim);
        hub.deposit(10 ether, victim);
        assertGt(hub.balanceOf(victim), 0);
    }
}
