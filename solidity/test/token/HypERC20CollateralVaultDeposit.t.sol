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

import {HypERC4626} from "../../contracts/token/extensions/HypERC4626.sol";

import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {HypTokenTest} from "./HypERC20.t.sol";

import {HypERC4626OwnerCollateral} from "../../contracts/token/extensions/HypERC4626OwnerCollateral.sol";
import "../../contracts/test/ERC4626/ERC4626Test.sol";

contract HypERC4626OwnerCollateralTest is HypTokenTest {
    using TypeCasts for address;

    uint256 constant DUST_AMOUNT = 1e11;
    HypERC4626OwnerCollateral internal erc20CollateralVaultDeposit;
    ERC4626Test vault;

    function setUp() public override {
        super.setUp();
        vault = new ERC4626Test(address(primaryToken), "Regular Vault", "RV");

        HypERC4626OwnerCollateral implementation = new HypERC4626OwnerCollateral(
                vault,
                SCALE,
                address(localMailbox)
            );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC4626OwnerCollateral.initialize.selector,
                address(address(noopHook)),
                address(igp),
                address(this)
            )
        );
        localToken = HypERC4626OwnerCollateral(address(proxy));
        erc20CollateralVaultDeposit = HypERC4626OwnerCollateral(
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

    function _transferRoundTripAndIncreaseYields(
        uint256 transferAmount,
        uint256 yieldAmount
    ) internal {
        // Transfer from Alice to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransfer(0, transferAmount);

        // Increase vault balance, which will reduce share redeemed for the same amount
        primaryToken.mintTo(address(vault), yieldAmount);

        // Transfer back from Bob to Alice
        vm.prank(BOB);
        remoteToken.transferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );
    }

    function testERC4626VaultDeposit_RemoteTransfer_deposits_intoVault(
        uint256 transferAmount
    ) public {
        transferAmount = bound(transferAmount, 0, TOTAL_SUPPLY);

        vm.prank(ALICE);
        _mintAndApprove(transferAmount, address(localToken));

        // Check vault shares balance before and after transfer
        assertEq(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransfer(0, transferAmount);

        assertApproxEqAbs(
            vault.maxRedeem(address(erc20CollateralVaultDeposit)),
            transferAmount,
            1
        );
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), transferAmount);
    }

    function testERC4626VaultDeposit_RemoteTransfer_withdraws_fromVault(
        uint256 transferAmount
    ) public {
        transferAmount = bound(transferAmount, 0, TOTAL_SUPPLY);

        vm.prank(ALICE);
        _mintAndApprove(transferAmount, address(localToken));
        _transferRoundTripAndIncreaseYields(transferAmount, DUST_AMOUNT);

        // Check Alice's local token balance
        uint256 prevBalance = localToken.balanceOf(ALICE);
        _handleLocalTransfer(transferAmount);

        assertEq(localToken.balanceOf(ALICE), prevBalance + transferAmount);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
    }

    function testERC4626VaultDeposit_RemoteTransfer_withdraws_lessShares(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        rewardAmount = bound(rewardAmount, DUST_AMOUNT, TOTAL_SUPPLY);

        _transferRoundTripAndIncreaseYields(TRANSFER_AMT, rewardAmount);

        // Check Alice's local token balance
        uint256 prevBalance = localToken.balanceOf(ALICE);
        _handleLocalTransfer(TRANSFER_AMT);
        assertEq(localToken.balanceOf(ALICE), prevBalance + TRANSFER_AMT);

        // Has leftover shares, but no assets deposited
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
        assertGt(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
    }

    function testERC4626VaultDeposit_RemoteTransfer_sweep_revertNonOwner(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        rewardAmount = bound(rewardAmount, DUST_AMOUNT, TOTAL_SUPPLY);
        _transferRoundTripAndIncreaseYields(TRANSFER_AMT, rewardAmount);

        vm.startPrank(BOB);
        vm.expectRevert(abi.encodePacked("Ownable: caller is not the owner"));
        erc20CollateralVaultDeposit.sweep();
        vm.stopPrank();
    }

    function testERC4626VaultDeposit_RemoteTransfer_sweep_noExcessShares(
        uint256 transferAmount
    ) public {
        testERC4626VaultDeposit_RemoteTransfer_deposits_intoVault(
            transferAmount
        );

        uint256 ownerBalancePrev = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );

        erc20CollateralVaultDeposit.sweep();
        assertEq(
            primaryToken.balanceOf(erc20CollateralVaultDeposit.owner()),
            ownerBalancePrev
        );
    }

    function testERC4626VaultDeposit_RemoteTransfer_sweep_excessShares12312(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        rewardAmount = bound(rewardAmount, DUST_AMOUNT, TOTAL_SUPPLY);

        _transferRoundTripAndIncreaseYields(TRANSFER_AMT, rewardAmount);
        _handleLocalTransfer(TRANSFER_AMT);

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

    function testERC4626VaultDeposit_RemoteTransfer_sweep_excessSharesMultipleDeposit(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        rewardAmount = bound(rewardAmount, DUST_AMOUNT, TOTAL_SUPPLY);

        _transferRoundTripAndIncreaseYields(TRANSFER_AMT, rewardAmount);
        _handleLocalTransfer(TRANSFER_AMT);

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

    function testERC4626VaultDeposit_TransferFromSender_CorrectMetadata()
        public
    {
        remoteToken = new HypERC4626(
            DECIMALS,
            SCALE,
            address(remoteMailbox),
            ORIGIN
        );
        _enrollRemoteTokenRouter();
        vm.prank(ALICE);

        primaryToken.approve(address(localToken), TRANSFER_AMT);
        _performRemoteTransfer(0, TRANSFER_AMT, 1);

        assertEq(HypERC4626(address(remoteToken)).exchangeRate(), 1e10);
        assertEq(HypERC4626(address(remoteToken)).previousNonce(), 1);
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

    function _performRemoteTransfer(
        uint256 _msgValue,
        uint256 _amount,
        uint32 _nonce
    ) internal {
        vm.prank(ALICE);
        localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(ORIGIN, BOB.addressToBytes32(), _amount);
        bytes memory _tokenMessage = TokenMessage.format(
            BOB.addressToBytes32(),
            _amount,
            abi.encode(uint256(1e10), _nonce)
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            _tokenMessage
        );

        assertEq(remoteToken.balanceOf(BOB), _amount);
    }
}
