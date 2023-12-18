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

    function testRemoteTransfer_deposits_intoVault() public {
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);

        // Check vault shares balance before and after transfer
        assertEq(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);

        _performRemoteTransfer(0, TRANSFER_AMT);
        assertEq(
            vault.maxRedeem(address(erc20CollateralVaultDeposit)),
            TRANSFER_AMT
        );
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), TRANSFER_AMT);
    }

    function testRemoteTransfer_withdraws_fromVault() public {
        // Transfer to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT);

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
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
    }

    function testRemoteTransfer_withdraws_lessShares() public {
        // Transfer to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT);

        // Increase vault balance, which will reduce share redemptions for the same amount
        primaryToken.transfer(address(vault), 1 ether);

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

    function testRemoteTransfer_sweep_revertNonOwner() public {
        testRemoteTransfer_withdraws_lessShares();
        vm.startPrank(BOB);
        vm.expectRevert(abi.encodePacked("Ownable: caller is not the owner"));
        erc20CollateralVaultDeposit.sweep();
        vm.stopPrank();
    }

    function testRemoteTransfer_sweep_excessShares() public {
        testRemoteTransfer_withdraws_lessShares();

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

    function testRemoteTransfer_sweep_excessSharesAfterDeposit() public {
        testRemoteTransfer_withdraws_lessShares();

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
}
