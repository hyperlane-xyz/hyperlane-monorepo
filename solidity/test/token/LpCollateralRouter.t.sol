// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {TestLpCollateralRouter} from "../../contracts/test/TestLpCollateralRouter.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LpCollateralRouterTest is Test {
    event Donation(address sender, uint256 amount);

    TestLpCollateralRouter internal router;
    address internal alice = address(0x1);
    address internal bob = address(0x2);
    uint256 internal constant DEPOSIT_AMOUNT = 100e18;
    uint256 internal constant DONATE_AMOUNT = 50e18;

    function setUp() public {
        MockMailbox mailbox = new MockMailbox(1);
        router = new TestLpCollateralRouter(1, address(mailbox));
        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
    }

    function testDepositIncreasesBalances() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.deposit(DEPOSIT_AMOUNT, alice);
        assertEq(router.balanceOf(alice), shares);
        assertEq(router.totalAssets(), DEPOSIT_AMOUNT);
    }

    function testWithdrawDecreasesBalances() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT, bob, alice);
        assertEq(router.balanceOf(alice), 0);
        assertEq(router.totalAssets(), 0);
    }

    function testTotalSupplyTracksShares() public {
        assertEq(router.totalSupply(), 0);
        vm.prank(alice);
        router.deposit(DEPOSIT_AMOUNT, alice);
        assertEq(router.totalSupply(), router.balanceOf(alice));
    }

    function testTotalAssetsTracksDepositsAndWithdrawals() public {
        assertEq(router.totalAssets(), 0);
        vm.prank(alice);
        router.deposit(DEPOSIT_AMOUNT, alice);
        assertEq(router.totalAssets(), DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT, bob, alice);
        assertEq(router.totalAssets(), 0);
    }

    function testDonateIncreasesTotalAssets() public {
        assertEq(router.totalAssets(), 0);
        vm.prank(alice);
        router.donate(DONATE_AMOUNT);
        assertEq(router.totalAssets(), DONATE_AMOUNT);
    }

    function testDonateEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Donation(alice, DONATE_AMOUNT);
        vm.prank(alice);
        router.donate(DONATE_AMOUNT);
    }

    function testDonateIsNotWithdrawable() public {
        vm.prank(alice);
        router.donate(DONATE_AMOUNT);
        vm.prank(alice);
        vm.expectRevert();
        router.withdraw(DONATE_AMOUNT, bob, alice);
    }

    function testWithdrawMoreThanBalanceReverts() public {
        vm.prank(alice);
        router.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vm.expectRevert();
        router.withdraw(DEPOSIT_AMOUNT + 1, bob, alice);
    }

    function testDonateDistributesToAllHolders(
        uint8 aliceFactor,
        uint8 bobFactor
    ) public {
        aliceFactor = uint8(bound(aliceFactor, 1, 100));
        bobFactor = uint8(bound(bobFactor, 1, 100));

        uint256 aliceDeposit = aliceFactor * DEPOSIT_AMOUNT;
        uint256 bobDeposit = bobFactor * DEPOSIT_AMOUNT;
        uint256 donation = DONATE_AMOUNT;

        // Alice deposits
        vm.prank(alice);
        uint256 aliceShares = router.deposit(aliceDeposit, alice);

        // Bob deposits
        vm.prank(bob);
        uint256 bobShares = router.deposit(bobDeposit, bob);

        // Donate to the vault
        router.donate(donation);

        uint256 totalShares = aliceShares + bobShares;
        uint256 aliceDonation = (donation * aliceShares) / totalShares;
        uint256 bobDonation = (donation * bobShares) / totalShares;

        // account for rounding errors
        assertApproxEqAbs(
            router.maxWithdraw(alice),
            aliceShares + aliceDonation,
            1
        );
        assertApproxEqAbs(router.maxWithdraw(bob), bobShares + bobDonation, 1);
    }
}
