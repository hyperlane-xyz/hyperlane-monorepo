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
    uint256 internal constant SCALE = 1;
    uint256 internal constant INITIAL_SUPPLY = 1_000_000e18;
    uint256 internal constant DEPOSIT_AMOUNT = 100e18;
    uint256 internal constant DONATE_AMOUNT = 50e18;

    function setUp() public {
        MockMailbox mailbox = new MockMailbox(1);
        router = new TestLpCollateralRouter(SCALE, address(mailbox));
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
}
