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
import {ITokenBridge} from "../../contracts/interfaces/ITokenBridge.sol";

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
    event PrincipalDeposited(
        address indexed depositor,
        uint256 assets,
        uint256 shares
    );
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

        // Self-enroll the warp route for its local domain to enable local rebalancing
        // This is required for addBridge() and rebalance() to work with the local domain
        warpRoute.enrollRemoteRouter(
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

        // Add bridge to warp route for local domain and add rebalancer
        warpRoute.addBridge(ORIGIN, ITokenBridge(address(bridge)));
        warpRoute.addRebalancer(REBALANCER);

        // Fund ALICE and warp route
        token.transfer(ALICE, 100_000e18);
        token.transfer(address(warpRoute), 50_000e18); // Collateral in warp route
    }

    // ============ Helper Functions ============

    /// @dev Deposits via the real rebalance flow (rebalancer -> warpRoute.rebalance -> bridge.transferRemote)
    function _depositViaRebalance(uint256 amount) internal {
        vm.prank(REBALANCER);
        warpRoute.rebalance(ORIGIN, amount, ITokenBridge(address(bridge)));
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

    // ============ Rebalance (Deposit) Tests ============

    function test_rebalance_depositsToVault() public {
        uint256 depositAmount = 1000e18;

        uint256 vaultSharesBefore = vault.balanceOf(address(bridge));
        uint256 principalBefore = bridge.principalDeposited();
        uint256 warpRouteBalanceBefore = token.balanceOf(address(warpRoute));

        vm.expectEmit(true, false, false, true);
        emit PrincipalDeposited(
            address(warpRoute),
            depositAmount,
            depositAmount
        ); // 1:1 initially

        _depositViaRebalance(depositAmount);

        assertEq(
            vault.balanceOf(address(bridge)),
            vaultSharesBefore + depositAmount
        );
        assertEq(bridge.principalDeposited(), principalBefore + depositAmount);
        // Warp route balance decreased
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBefore - depositAmount
        );
    }

    function test_rebalance_multipleDeposits() public {
        uint256 firstDeposit = 1000e18;
        uint256 secondDeposit = 500e18;

        _depositViaRebalance(firstDeposit);
        _depositViaRebalance(secondDeposit);

        assertEq(bridge.principalDeposited(), firstDeposit + secondDeposit);
    }

    function test_rebalance_onlyRebalancerCanCall() public {
        uint256 depositAmount = 1000e18;

        // Non-rebalancer (ALICE) tries to rebalance
        vm.prank(ALICE);
        vm.expectRevert("MCR: Only Rebalancer");
        warpRoute.rebalance(
            ORIGIN,
            depositAmount,
            ITokenBridge(address(bridge))
        );
    }

    function test_rebalance_onlyAllowedBridge() public {
        uint256 depositAmount = 1000e18;

        // Deploy another bridge that's not allowed
        ERC4626RebalancingBridge otherBridge = new ERC4626RebalancingBridge(
            IERC4626(address(vault)),
            warpRoute
        );

        vm.prank(REBALANCER);
        vm.expectRevert("MCR: Not allowed bridge");
        warpRoute.rebalance(
            ORIGIN,
            depositAmount,
            ITokenBridge(address(otherBridge))
        );
    }

    function test_transferRemote_revertsOnNonWarpRouteCaller() public {
        uint256 depositAmount = 1000e18;

        // Fund and approve from ALICE (not warp route)
        token.transfer(ALICE, depositAmount);
        vm.prank(ALICE);
        token.approve(address(bridge), depositAmount);

        // Try to call transferRemote directly (not through warp route)
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626RebalancingBridge.OnlyWarpRoute.selector,
                ALICE
            )
        );
        bridge.transferRemote(ORIGIN, BOB.addressToBytes32(), depositAmount);
    }

    // ============ WithdrawPrincipal Tests ============

    function test_withdrawPrincipal_withdrawsToWarpRoute() public {
        uint256 depositAmount = 1000e18;
        uint256 withdrawAmount = 500e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        uint256 warpRouteBalanceBefore = token.balanceOf(address(warpRoute));
        uint256 principalBefore = bridge.principalDeposited();

        vm.expectEmit(true, false, false, false);
        emit PrincipalWithdrawn(address(warpRoute), withdrawAmount, 0);

        // Rebalancer withdraws principal (goes to warp route, not caller)
        vm.prank(REBALANCER);
        uint256 assets = bridge.withdrawPrincipal(withdrawAmount);

        assertEq(assets, withdrawAmount);
        // Funds go to warp route, not to the rebalancer
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBefore + withdrawAmount
        );
        assertEq(bridge.principalDeposited(), principalBefore - withdrawAmount);
    }

    function test_withdrawPrincipal_revertsOnNotRebalancer() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        // Non-rebalancer (ALICE) tries to withdraw
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626RebalancingBridge.NotAllowedRebalancer.selector,
                ALICE
            )
        );
        bridge.withdrawPrincipal(500e18);
    }

    function test_withdrawPrincipal_revertsOnInsufficientPrincipal() public {
        uint256 depositAmount = 1000e18;
        uint256 withdrawAmount = 1500e18; // More than deposited

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626RebalancingBridge.InsufficientPrincipal.selector,
                withdrawAmount,
                depositAmount
            )
        );
        bridge.withdrawPrincipal(withdrawAmount);
    }

    function test_withdrawPrincipal_fullWithdrawal() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        uint256 warpRouteBalanceBefore = token.balanceOf(address(warpRoute));

        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(depositAmount);

        assertEq(bridge.principalDeposited(), 0);
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBefore + depositAmount
        );
    }

    function test_withdrawPrincipal_autoClaimsYield() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        // Simulate yield
        token.mintTo(address(vault), yieldAmount);

        uint256 feeRecipientBefore = token.balanceOf(FEE_RECIPIENT);
        uint256 calculatedYield = bridge.calculateYield();
        assertGt(calculatedYield, 0);

        // withdrawPrincipal should auto-claim yield first
        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(500e18);

        // Yield was sent to fee recipient
        assertGt(token.balanceOf(FEE_RECIPIENT), feeRecipientBefore);
        // No yield left to claim
        assertEq(bridge.calculateYield(), 0);
    }

    function test_withdrawPrincipal_autoClaimSkipsWhenNoYield() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit via rebalance flow, no yield accrued
        _depositViaRebalance(depositAmount);

        uint256 feeRecipientBefore = token.balanceOf(FEE_RECIPIENT);

        // withdrawPrincipal should not revert even with no yield
        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(500e18);

        // Fee recipient balance unchanged (no yield to claim)
        assertEq(token.balanceOf(FEE_RECIPIENT), feeRecipientBefore);
    }

    function test_withdrawPrincipal_autoClaimSkipsWhenNoFeeRecipient() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);
        token.mintTo(address(vault), yieldAmount);

        // Remove fee recipient
        warpRoute.setFeeRecipient(address(0));

        // withdrawPrincipal should not revert — auto-claim silently skips
        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(500e18);

        assertEq(bridge.principalDeposited(), 500e18);
    }

    function test_withdrawPrincipal_multipleRebalancersAllowed() public {
        uint256 depositAmount = 1000e18;

        // Setup: deposit via rebalance flow
        _depositViaRebalance(depositAmount);

        // Add another rebalancer
        address REBALANCER2 = address(0x5);
        warpRoute.addRebalancer(REBALANCER2);

        // Both rebalancers can withdraw
        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(300e18);

        vm.prank(REBALANCER2);
        bridge.withdrawPrincipal(300e18);

        assertEq(bridge.principalDeposited(), 400e18);
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_returnsAmountWithNoFees() public view {
        uint256 transferAmount = 1000e18;
        Quote[] memory quotes = bridge.quoteTransferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(token));
        assertEq(quotes[0].amount, transferAmount); // Amount needed, no additional fees
    }

    // ============ Yield Claiming Tests ============

    function test_claimYield_claimsAccruedYield() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit via rebalance
        _depositViaRebalance(depositAmount);

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
        _depositViaRebalance(depositAmount);

        vm.expectRevert(ERC4626RebalancingBridge.NoYieldToClaim.selector);
        bridge.claimYield();
    }

    function test_claimYield_revertsOnZeroFeeRecipient() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        // Setup: deposit with yield
        _depositViaRebalance(depositAmount);
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
        _depositViaRebalance(depositAmount);
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

        // Setup: deposit via rebalance
        _depositViaRebalance(depositAmount);

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

    function test_calculateYield_returnsZeroForNewDeposit() public {
        uint256 depositAmount = 1000e18;

        _depositViaRebalance(depositAmount);

        assertEq(bridge.calculateYield(), 0);
    }

    // ============ Integration Tests ============

    function test_fullFlow_depositYieldWithdraw() public {
        uint256 depositAmount = 1000e18;
        uint256 yieldAmount = 100e18;

        uint256 warpRouteBalanceBefore = token.balanceOf(address(warpRoute));

        // 1. Deposit via rebalance
        _depositViaRebalance(depositAmount);

        assertEq(bridge.principalDeposited(), depositAmount);
        assertEq(
            vault.convertToAssets(vault.balanceOf(address(bridge))),
            depositAmount
        );
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBefore - depositAmount
        );

        // 2. Yield accrues
        token.mintTo(address(vault), yieldAmount);
        assertGt(bridge.calculateYield(), 0);
        assertGt(
            vault.convertToAssets(vault.balanceOf(address(bridge))),
            depositAmount
        );

        // 3. Claim yield
        uint256 claimed = bridge.claimYield();
        assertGt(claimed, 0);
        assertGt(token.balanceOf(FEE_RECIPIENT), 0);

        // 4. Withdraw principal (goes back to warp route)
        uint256 withdrawAmount = 500e18;
        uint256 warpRouteBalanceBeforeWithdraw = token.balanceOf(
            address(warpRoute)
        );

        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(withdrawAmount);

        assertEq(bridge.principalDeposited(), depositAmount - withdrawAmount);
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBeforeWithdraw + withdrawAmount
        );

        // 5. More yield, claim again
        token.mintTo(address(vault), yieldAmount);
        uint256 claimed2 = bridge.claimYield();
        assertGt(claimed2, 0);

        // 6. Withdraw remaining principal
        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(depositAmount - withdrawAmount);

        assertEq(bridge.principalDeposited(), 0);
    }

    function test_fuzz_depositAndWithdraw(uint256 depositAmount) public {
        // Bound to warp route's balance
        depositAmount = bound(depositAmount, 1e18, 10_000e18);

        _depositViaRebalance(depositAmount);

        assertEq(bridge.principalDeposited(), depositAmount);

        // Withdraw half (goes to warp route)
        uint256 withdrawAmount = depositAmount / 2;
        uint256 warpRouteBalanceBefore = token.balanceOf(address(warpRoute));

        vm.prank(REBALANCER);
        bridge.withdrawPrincipal(withdrawAmount);

        assertEq(bridge.principalDeposited(), depositAmount - withdrawAmount);
        assertEq(
            token.balanceOf(address(warpRoute)),
            warpRouteBalanceBefore + withdrawAmount
        );
    }

    function test_fuzz_yieldClaiming(
        uint256 depositAmount,
        uint256 yieldPercent
    ) public {
        // Bound to warp route's balance
        depositAmount = bound(depositAmount, 1e18, 10_000e18);
        yieldPercent = bound(yieldPercent, 1, 100); // 1% to 100%

        _depositViaRebalance(depositAmount);

        // Add yield
        uint256 yieldAmount = (depositAmount * yieldPercent) / 100;
        token.mintTo(address(vault), yieldAmount);

        uint256 calculated = bridge.calculateYield();
        assertGt(calculated, 0);

        uint256 feeRecipientBefore = token.balanceOf(FEE_RECIPIENT);
        bridge.claimYield();
        assertGt(token.balanceOf(FEE_RECIPIENT), feeRecipientBefore);
    }

    // ============ Self-Enrollment Tests ============

    function test_selfEnrollment_requiredForLocalRebalancing() public {
        // Deploy a new warp route WITHOUT self-enrollment
        HypERC20Collateral newImplementation = new HypERC20Collateral(
            address(token),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        TransparentUpgradeableProxy newProxy = new TransparentUpgradeableProxy(
            address(newImplementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20Collateral.initialize.selector,
                address(noopHook),
                address(0),
                address(this)
            )
        );
        HypERC20Collateral newWarpRoute = HypERC20Collateral(address(newProxy));

        // Only enroll remote router (not self)
        newWarpRoute.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        // Deploy bridge for new warp route
        ERC4626RebalancingBridge newBridge = new ERC4626RebalancingBridge(
            IERC4626(address(vault)),
            newWarpRoute
        );

        // Try to add bridge for local domain - should fail without self-enrollment
        vm.expectRevert("No router enrolled for domain: 11");
        newWarpRoute.addBridge(ORIGIN, ITokenBridge(address(newBridge)));
    }

    function test_selfEnrollment_enablesLocalRebalancing() public {
        // Deploy a new warp route WITH self-enrollment
        HypERC20Collateral newImplementation = new HypERC20Collateral(
            address(token),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        TransparentUpgradeableProxy newProxy = new TransparentUpgradeableProxy(
            address(newImplementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20Collateral.initialize.selector,
                address(noopHook),
                address(0),
                address(this)
            )
        );
        HypERC20Collateral newWarpRoute = HypERC20Collateral(address(newProxy));

        // Enroll remote AND self
        newWarpRoute.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        newWarpRoute.enrollRemoteRouter(
            ORIGIN,
            address(newWarpRoute).addressToBytes32()
        );

        // Deploy bridge for new warp route
        ERC4626RebalancingBridge newBridge = new ERC4626RebalancingBridge(
            IERC4626(address(vault)),
            newWarpRoute
        );

        // Now adding bridge should succeed
        newWarpRoute.addBridge(ORIGIN, ITokenBridge(address(newBridge)));

        // Verify bridge was added
        address[] memory bridges = newWarpRoute.allowedBridges(ORIGIN);
        assertEq(bridges.length, 1);
        assertEq(bridges[0], address(newBridge));
    }
}
