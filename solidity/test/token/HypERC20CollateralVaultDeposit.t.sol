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
import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HypTokenTest} from "./HypERC20.t.sol";

import {HypERC20CollateralVaultDeposit} from "../../contracts/token/HypERC20CollateralVaultDeposit.sol";
import "../../contracts/test/ERC4626/ERC4626Test.sol";

contract HypERC20CollateralVaultDepositTest is HypTokenTest {
    using TypeCasts for address;
    uint constant DUST_AMOUNT = 1e11;
    HypERC20CollateralVaultDeposit internal erc20CollateralVaultDeposit;
    ERC4626Test vault;

    function setUp() public override {
        super.setUp();
        vault = new ERC4626Test(address(primaryToken), "Regular Vault", "RV");

        localToken = new HypERC20CollateralVaultDeposit(
            address(vault),
            address(primaryToken),
            address(localMailbox)
        );
        erc20CollateralVaultDeposit = HypERC20CollateralVaultDeposit(
            address(localToken)
        );

        erc20CollateralVaultDeposit.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));
        primaryToken.transfer(ALICE, 1000e18);
        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer_deposits_intoVault(
        uint256 transferAmount
    ) public {
        vm.assume(transferAmount < TOTAL_SUPPLY);

        vm.startPrank(ALICE);
        primaryToken.mint(transferAmount);
        primaryToken.approve(address(localToken), transferAmount);
        vm.stopPrank();

        // Check vault shares balance before and after transfer
        assertEq(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);

        _performRemoteTransfer(0, transferAmount);
        assertApproxEqAbs(
            vault.maxRedeem(address(erc20CollateralVaultDeposit)),
            transferAmount,
            1
        );
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), transferAmount);
    }

    function testRemoteTransfer_withdraws_fromVault(
        uint256 transferAmount
    ) public {
        vm.assume(transferAmount < TOTAL_SUPPLY);

        // Transfer to Bob
        vm.startPrank(ALICE);
        primaryToken.mint(transferAmount);
        primaryToken.approve(address(localToken), transferAmount);
        vm.stopPrank();

        _performRemoteTransfer(0, transferAmount);

        // Transfer back from Bob to Alice
        vm.prank(BOB);
        remoteToken.transferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );

        // Check Alice's local token balance
        uint256 prevBalance = localToken.balanceOf(ALICE);
        vm.prank(address(localMailbox));
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(ALICE.addressToBytes32(), transferAmount)
        );

        assertEq(localToken.balanceOf(ALICE), prevBalance + transferAmount);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
    }

    function testRemoteTransfer_withdraws_lessShares(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        vm.assume(rewardAmount > DUST_AMOUNT);
        vm.assume(rewardAmount < TOTAL_SUPPLY);

        // Transfer to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT);

        // Increase vault balance, which will reduce share redeemed for the same amount
        primaryToken.mint(rewardAmount);
        primaryToken.transfer(address(vault), rewardAmount);

        // Transfer back from Bob to Alice
        vm.prank(BOB);
        remoteToken.transferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Check Alice's local token balance
        uint256 prevBalance = localToken.balanceOf(ALICE);
        vm.prank(address(localMailbox));
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(ALICE.addressToBytes32(), TRANSFER_AMT)
        );

        assertEq(localToken.balanceOf(ALICE), prevBalance + TRANSFER_AMT);

        // Has leftover shares, but no assets deposited
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
        assertGt(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
    }

    function testRemoteTransfer_sweep_revertNonOwner(
        uint256 rewardAmount
    ) public {
        testRemoteTransfer_withdraws_lessShares(rewardAmount);
        vm.startPrank(BOB);
        vm.expectRevert(abi.encodePacked("Ownable: caller is not the owner"));
        erc20CollateralVaultDeposit.sweep();
        vm.stopPrank();
    }

    function testRemoteTransfer_sweep_noExcessShares(
        uint256 transferAmount
    ) public {
        testRemoteTransfer_deposits_intoVault(transferAmount);

        uint256 ownerBalancePrev = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );

        erc20CollateralVaultDeposit.sweep();
        assertEq(
            primaryToken.balanceOf(erc20CollateralVaultDeposit.owner()),
            ownerBalancePrev
        );
    }

    function testRemoteTransfer_sweep_excessShares(
        uint256 rewardAmount
    ) public {
        testRemoteTransfer_withdraws_lessShares(rewardAmount);

        uint256 ownerBalancePrev = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );
        uint256 excessAmount = vault.maxRedeem(
            address(erc20CollateralVaultDeposit)
        );

        erc20CollateralVaultDeposit.sweep();
        assertGt(
            primaryToken.balanceOf(erc20CollateralVaultDeposit.owner()),
            ownerBalancePrev + excessAmount
        );
    }

    function testRemoteTransfer_sweep_excessSharesMultipleDeposit(
        uint256 rewardAmount
    ) public {
        testRemoteTransfer_withdraws_lessShares(rewardAmount);

        uint256 ownerBalancePrev = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );
        uint256 excessAmount = vault.maxRedeem(
            address(erc20CollateralVaultDeposit)
        );

        // Deposit again for Alice
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT);

        // Sweep and check
        erc20CollateralVaultDeposit.sweep();
        assertGt(
            primaryToken.balanceOf(erc20CollateralVaultDeposit.owner()),
            ownerBalancePrev + excessAmount
        );
    }

    function testBenchmark_overheadGasUsage() public override {
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT);

        vm.prank(address(localMailbox));

        uint256 gasBefore = gasleft();
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), TRANSFER_AMT)
        );
        uint256 gasAfter = gasleft();
        console.log("Overhead gas usage: %d", gasBefore - gasAfter);
    }
}
