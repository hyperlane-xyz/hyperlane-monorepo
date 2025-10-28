// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";

contract HypNativeLpTest is Test {
    event Donation(address sender, uint256 amount);
    event Deposit(
        address indexed sender,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    HypNative internal router;
    address internal alice = address(0x1);
    address internal bob = address(0x2);
    uint256 internal constant DEPOSIT_AMOUNT = 100e18;
    uint256 internal constant DONATE_AMOUNT = 50e18;

    function setUp() public {
        MockMailbox mailbox = new MockMailbox(1);
        router = new HypNative(1, address(mailbox));
        router.initialize(address(0), address(0), address(this));

        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
        vm.deal(alice, 1000e18);
        vm.deal(bob, 1000e18);
    }

    function testDepositIncreasesBalances() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        assertEq(router.balanceOf(alice), shares);
        assertEq(router.totalAssets(), DEPOSIT_AMOUNT);
    }

    function testDepositEmitsEvent() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit Deposit(alice, alice, DEPOSIT_AMOUNT, shares);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
    }

    function testDepositWithZeroValue() public {
        vm.prank(alice);
        uint256 shares = router.deposit(alice);
        assertEq(shares, 0);
        assertEq(router.balanceOf(alice), 0);
    }

    function testDepositToReceiverCreditsCorrectAccount() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(bob);
        assertEq(router.balanceOf(bob), shares);
        assertEq(router.balanceOf(alice), 0);
    }

    function testWithdrawDecreasesBalances() public {
        uint256 shares = router.previewDeposit(DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT, bob, alice);
        assertEq(router.balanceOf(alice), 0);
        assertEq(router.totalAssets(), 0);
        assertEq(bob.balance, 1000e18 + DEPOSIT_AMOUNT);
    }

    function testWithdrawEmitsEvent() public {
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        uint256 shares = router.balanceOf(alice);
        vm.expectEmit(true, true, true, true);
        emit Withdraw(alice, bob, alice, DEPOSIT_AMOUNT, shares);
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT, bob, alice);
    }

    function testTotalSupplyTracksShares() public {
        assertEq(router.totalSupply(), 0);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        assertEq(router.totalSupply(), router.balanceOf(alice));
    }

    function testTotalAssetsTracksDepositsAndWithdrawals() public {
        assertEq(router.totalAssets(), 0);
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        assertEq(router.totalAssets(), DEPOSIT_AMOUNT);
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT, bob, alice);
        assertEq(router.totalAssets(), 0);
    }

    function testDonateIncreasesTotalAssets() public {
        assertEq(router.totalAssets(), 0);
        vm.prank(alice);
        router.donate{value: DONATE_AMOUNT}(DONATE_AMOUNT);
        assertEq(router.totalAssets(), DONATE_AMOUNT);
    }

    function testDonateEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Donation(alice, DONATE_AMOUNT);
        vm.prank(alice);
        router.donate{value: DONATE_AMOUNT}(DONATE_AMOUNT);
    }

    function testDonateIsNotWithdrawable() public {
        vm.prank(alice);
        router.donate{value: DONATE_AMOUNT}(DONATE_AMOUNT);
        vm.prank(alice);
        vm.expectRevert();
        router.withdraw(DONATE_AMOUNT, bob, alice);
    }

    function testWithdrawMoreThanBalanceReverts() public {
        vm.prank(alice);
        router.deposit{value: DEPOSIT_AMOUNT}(alice);
        vm.prank(alice);
        vm.expectRevert();
        router.withdraw(DEPOSIT_AMOUNT + 1, bob, alice);
    }

    function testDonateDistributesToAllHolders() public {
        uint256 aliceDeposit = 100e18;
        uint256 bobDeposit = 200e18;
        uint256 donation = DONATE_AMOUNT;

        // Alice deposits
        vm.prank(alice);
        router.deposit{value: aliceDeposit}(alice);

        // Bob deposits
        vm.prank(bob);
        router.deposit{value: bobDeposit}(bob);

        // Record balances before donation
        uint256 aliceWithdrawBefore = router.maxWithdraw(alice);
        uint256 bobWithdrawBefore = router.maxWithdraw(bob);

        // Donate to the vault
        vm.deal(address(this), donation);
        router.donate{value: donation}(donation);

        // After donation, both should be able to withdraw more
        assertGt(router.maxWithdraw(alice), aliceWithdrawBefore);
        assertGt(router.maxWithdraw(bob), bobWithdrawBefore);

        // Alice should get 1/3 of donation, Bob should get 2/3
        assertEq(router.maxWithdraw(alice), aliceDeposit + donation / 3);
        assertEq(router.maxWithdraw(bob), bobDeposit + (donation * 2) / 3);
    }

    function testMultipleDepositsAndWithdrawals() public {
        // Alice deposits
        vm.prank(alice);
        uint256 aliceShares = router.deposit{value: DEPOSIT_AMOUNT}(alice);

        // Bob deposits
        vm.prank(bob);
        uint256 bobShares = router.deposit{value: DEPOSIT_AMOUNT * 2}(bob);

        assertEq(router.totalAssets(), DEPOSIT_AMOUNT * 3);
        assertEq(router.totalSupply(), aliceShares + bobShares);

        // Alice withdraws half
        vm.prank(alice);
        router.withdraw(DEPOSIT_AMOUNT / 2, alice, alice);

        assertEq(router.totalAssets(), DEPOSIT_AMOUNT * 3 - DEPOSIT_AMOUNT / 2);
        assertEq(alice.balance, 1000e18 - DEPOSIT_AMOUNT + DEPOSIT_AMOUNT / 2);

        // Bob withdraws all
        uint256 bobMaxWithdraw = router.maxWithdraw(bob);
        vm.prank(bob);
        router.withdraw(bobMaxWithdraw, bob, bob);

        assertEq(bob.balance, 1000e18);
    }

    function testDepositAfterDonationGetsCorrectShares() public {
        // Alice deposits initially
        vm.prank(alice);
        uint256 aliceShares = router.deposit{value: DEPOSIT_AMOUNT}(alice);

        // Someone donates
        vm.deal(address(this), DONATE_AMOUNT);
        router.donate{value: DONATE_AMOUNT}(DONATE_AMOUNT);

        // Bob deposits same amount
        vm.prank(bob);
        uint256 bobShares = router.deposit{value: DEPOSIT_AMOUNT}(bob);

        // Bob should get fewer shares since totalAssets increased from donation
        assertLt(bobShares, aliceShares);
    }
}
