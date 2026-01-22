// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

import {ERC4626RebalancingBridge} from "../../contracts/token/bridge/ERC4626RebalancingBridge.sol";

contract ERC4626RebalancingBridgeTest is Test {
    using TypeCasts for address;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    string internal constant NAME = "TestToken";
    string internal constant SYMBOL = "TT";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant FEE_RECIPIENT = address(0x3);
    address internal constant REBALANCER = address(0x4);
    address internal constant PROXY_ADMIN = address(0x37);

    // Contracts
    ERC20Test internal token;
    ERC4626Test internal vault;
    HypERC20Collateral internal warpRoute;
    ERC4626RebalancingBridge internal bridge;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    HypERC20 internal remoteToken;

    // Events from ERC4626RebalancingBridge
    event Deposited(address indexed depositor, uint256 assets, uint256 shares);
    event PrincipalWithdrawn(
        address indexed recipient,
        uint256 assets,
        uint256 shares
    );
    event YieldClaimed(
        address indexed feeRecipient,
        uint256 yieldAmount,
        uint256 sharesBurned
    );

    function setUp() public {
        // Deploy mailboxes
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        // Deploy underlying token
        token = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        // Deploy ERC4626 vault
        vault = new ERC4626Test(address(token), "Vault Token", "vTT");

        // Deploy warp route (HypERC20Collateral)
        HypERC20Collateral implementation = new HypERC20Collateral(
            address(token),
            SCALE,
            address(localMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20Collateral.initialize.selector,
                address(noopHook),
                address(0),
                address(this)
            )
        );
        warpRoute = HypERC20Collateral(address(proxy));

        // Deploy remote token for warp route completeness
        HypERC20 remoteImplementation = new HypERC20(
            DECIMALS,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy remoteProxy = new TransparentUpgradeableProxy(
                address(remoteImplementation),
                PROXY_ADMIN,
                abi.encodeWithSelector(
                    HypERC20.initialize.selector,
                    0,
                    NAME,
                    SYMBOL,
                    address(noopHook),
                    address(0),
                    address(this)
                )
            );
        remoteToken = HypERC20(address(remoteProxy));

        // Enroll routers
        warpRoute.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(warpRoute).addressToBytes32()
        );

        // Set fee recipient on warp route
        warpRoute.setFeeRecipient(FEE_RECIPIENT);

        // Deploy the rebalancing bridge
        bridge = new ERC4626RebalancingBridge(
            IERC4626(address(vault)),
            warpRoute
        );

        // Fund ALICE and warp route
        token.transfer(ALICE, 100_000e18);
        token.transfer(address(warpRoute), 50_000e18); // Collateral in warp route
    }

    // ============ Helper Functions ============

    /// @dev Simulates depositing via transferRemote (how rebalance would work)
    function _depositViaBridge(uint256 amount) internal {
        // Approve bridge to pull from this contract (simulating warp route approval)
        token.approve(address(bridge), amount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            amount
        );
    }

    // ============ Constructor Tests ============

    function test_constructor_setsImmutables() public view {
        assertEq(address(bridge.vault()), address(vault));
        assertEq(address(bridge.asset()), address(token));
        assertEq(address(bridge.warpRoute()), address(warpRoute));
    }

    function test_constructor_revertsOnInvalidVault() public {
        vm.expectRevert(ERC4626RebalancingBridge.InvalidVault.selector);
        new ERC4626RebalancingBridge(IERC4626(address(0)), warpRoute);
    }

    function test_constructor_revertsOnInvalidWarpRoute() public {
        vm.expectRevert(ERC4626RebalancingBridge.InvalidWarpRoute.selector);
        new ERC4626RebalancingBridge(
            IERC4626(address(vault)),
            TokenRouter(address(0))
        );
    }

    function test_constructor_revertsOnAssetMismatch() public {
        // Deploy a different token for the vault
        ERC20Test otherToken = new ERC20Test(
            "Other",
            "OTH",
            TOTAL_SUPPLY,
            DECIMALS
        );
        ERC4626Test otherVault = new ERC4626Test(
            address(otherToken),
            "Other Vault",
            "vOTH"
        );

        vm.expectRevert(ERC4626RebalancingBridge.AssetMismatch.selector);
        new ERC4626RebalancingBridge(IERC4626(address(otherVault)), warpRoute);
    }

    // ============ TransferRemote (Deposit) Tests ============

    function test_transferRemote_depositsToVault() public {
        uint256 depositAmount = 1000e18;

        token.approve(address(bridge), depositAmount);

        uint256 vaultSharesBefore = vault.balanceOf(address(bridge));
        uint256 principalBefore = bridge.principalDeposited();

        vm.expectEmit(true, false, false, true);
        emit Deposited(address(this), depositAmount, depositAmount); // 1:1 initially

        bytes32 messageId = bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(messageId, bytes32(0)); // Local bridge returns 0
        assertEq(
            vault.balanceOf(address(bridge)),
            vaultSharesBefore + depositAmount
        );
        assertEq(bridge.principalDeposited(), principalBefore + depositAmount);
    }

    function test_transferRemote_multipleDeposits() public {
        uint256 firstDeposit = 1000e18;
        uint256 secondDeposit = 500e18;

        token.approve(address(bridge), firstDeposit + secondDeposit);

        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            firstDeposit
        );
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            secondDeposit
        );

        assertEq(bridge.principalDeposited(), firstDeposit + secondDeposit);
    }

    // ============ WithdrawPrincipal Tests ============

    function test_withdrawPrincipal_withdrawsFromVault() public {
        uint256 depositAmount = 1000e18;
        uint256 withdrawAmount = 500e18;

        // Setup: deposit first
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        uint256 recipientBalanceBefore = token.balanceOf(BOB);
        uint256 principalBefore = bridge.principalDeposited();

        vm.expectEmit(true, false, false, false);
        emit PrincipalWithdrawn(BOB, withdrawAmount, 0);

        uint256 assets = bridge.withdrawPrincipal(BOB, withdrawAmount);

        assertEq(assets, withdrawAmount);
        assertEq(token.balanceOf(BOB), recipientBalanceBefore + withdrawAmount);
        assertEq(bridge.principalDeposited(), principalBefore - withdrawAmount);
    }

    function test_withdrawPrincipal_revertsOnInsufficientPrincipal() public {
        uint256 depositAmount = 1000e18;
        uint256 withdrawAmount = 1500e18; // More than deposited

        // Setup: deposit first
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626RebalancingBridge.InsufficientPrincipal.selector,
                withdrawAmount,
                depositAmount
            )
        );
        bridge.withdrawPrincipal(BOB, withdrawAmount);
    }

    function test_withdrawPrincipal_fullWithdrawal() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit first
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        bridge.withdrawPrincipal(BOB, depositAmount);

        assertEq(bridge.principalDeposited(), 0);
        assertEq(token.balanceOf(BOB), depositAmount);
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_returnsZeroFees() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            1000e18
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(token));
        assertEq(quotes[0].amount, 0);
    }

    // ============ Yield Claiming Tests ============

    function test_claimYield_claimsAccruedYield() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        // Simulate yield: mint tokens directly to vault
        token.mintTo(address(vault), yieldAmount);

        uint256 calculatedYield = bridge.calculateYield();
        assertGt(calculatedYield, 0);

        uint256 feeRecipientBefore = token.balanceOf(FEE_RECIPIENT);

        vm.expectEmit(true, false, false, false); // Just check the event is emitted
        emit YieldClaimed(FEE_RECIPIENT, calculatedYield, 0);

        uint256 claimedYield = bridge.claimYield();

        assertGt(claimedYield, 0);
        assertEq(
            token.balanceOf(FEE_RECIPIENT),
            feeRecipientBefore + claimedYield
        );

        // Yield should be reset
        assertEq(bridge.calculateYield(), 0);
    }

    function test_claimYield_revertsOnNoYield() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit but no yield
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        vm.expectRevert(ERC4626RebalancingBridge.NoYieldToClaim.selector);
        bridge.claimYield();
    }

    function test_claimYield_revertsOnZeroFeeRecipient() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit with yield
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );
        token.mintTo(address(vault), yieldAmount);

        // Remove fee recipient
        warpRoute.setFeeRecipient(address(0));

        vm.expectRevert(ERC4626RebalancingBridge.ZeroFeeRecipient.selector);
        bridge.claimYield();
    }

    function test_claimYield_anyoneCanCall() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit with yield
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );
        token.mintTo(address(vault), yieldAmount);

        // Random caller claims yield
        vm.prank(ALICE);
        uint256 claimedYield = bridge.claimYield();

        assertGt(claimedYield, 0);
        assertGt(token.balanceOf(FEE_RECIPIENT), 0);
    }

    function test_claimYield_continualYieldClaiming() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 50e18;

        // Setup: deposit
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        // First yield
        token.mintTo(address(vault), yieldAmount);
        uint256 firstClaim = bridge.claimYield();
        assertGt(firstClaim, 0);

        // More yield
        token.mintTo(address(vault), yieldAmount);
        uint256 secondClaim = bridge.claimYield();
        assertGt(secondClaim, 0);

        // Total should be around 2x yield (minus rounding)
        assertGt(token.balanceOf(FEE_RECIPIENT), yieldAmount);
    }

    // ============ View Function Tests ============

    function test_totalAssets_returnsCorrectValue() public {
        uint256 depositAmount = 1000e18;

        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(bridge.totalAssets(), depositAmount);

        // Add yield
        uint256 yieldAmount = 100e18;
        token.mintTo(address(vault), yieldAmount);

        assertGt(bridge.totalAssets(), depositAmount);
    }

    function test_totalShares_returnsCorrectValue() public {
        uint256 depositAmount = 1000e18;

        assertEq(bridge.totalShares(), 0);

        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(bridge.totalShares(), depositAmount); // 1:1 for fresh vault
    }

    function test_calculateYield_returnsZeroForNewDeposit() public {
        uint256 depositAmount = 1000e18;

        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(bridge.calculateYield(), 0);
    }

    // ============ Integration Tests ============

    function test_fullFlow_depositYieldWithdraw() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // 1. Deposit
        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(bridge.principalDeposited(), depositAmount);
        assertEq(bridge.totalAssets(), depositAmount);

        // 2. Yield accrues
        token.mintTo(address(vault), yieldAmount);
        assertGt(bridge.calculateYield(), 0);
        assertGt(bridge.totalAssets(), depositAmount);

        // 3. Claim yield
        uint256 claimed = bridge.claimYield();
        assertGt(claimed, 0);
        assertGt(token.balanceOf(FEE_RECIPIENT), 0);

        // 4. Withdraw principal
        uint256 withdrawAmount = 500e18;
        bridge.withdrawPrincipal(BOB, withdrawAmount);

        assertEq(bridge.principalDeposited(), depositAmount - withdrawAmount);
        assertEq(token.balanceOf(BOB), withdrawAmount);

        // 5. More yield, claim again
        token.mintTo(address(vault), yieldAmount);
        uint256 claimed2 = bridge.claimYield();
        assertGt(claimed2, 0);

        // 6. Withdraw remaining principal
        bridge.withdrawPrincipal(BOB, depositAmount - withdrawAmount);

        assertEq(bridge.principalDeposited(), 0);
    }

    function test_fuzz_depositAndWithdraw(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, 10_000e18);

        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        assertEq(bridge.principalDeposited(), depositAmount);

        // Withdraw half
        uint256 withdrawAmount = depositAmount / 2;
        bridge.withdrawPrincipal(BOB, withdrawAmount);

        assertEq(bridge.principalDeposited(), depositAmount - withdrawAmount);
        assertEq(token.balanceOf(BOB), withdrawAmount);
    }

    function test_fuzz_yieldClaiming(
        uint256 depositAmount,
        uint256 yieldPercent
    ) public {
        depositAmount = bound(depositAmount, 1e18, 10_000e18);
        yieldPercent = bound(yieldPercent, 1, 100); // 1% to 100%

        token.approve(address(bridge), depositAmount);
        bridge.transferRemote(
            ORIGIN,
            address(warpRoute).addressToBytes32(),
            depositAmount
        );

        // Add yield
        uint256 yieldAmount = (depositAmount * yieldPercent) / 100;
        token.mintTo(address(vault), yieldAmount);

        uint256 calculated = bridge.calculateYield();
        assertGt(calculated, 0);

        uint256 feeRecipientBefore = token.balanceOf(FEE_RECIPIENT);
        bridge.claimYield();
        assertGt(token.balanceOf(FEE_RECIPIENT), feeRecipientBefore);
    }
}
