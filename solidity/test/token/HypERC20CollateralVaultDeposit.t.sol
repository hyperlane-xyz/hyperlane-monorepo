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
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {NonCompliantERC20Test} from "../../contracts/test/ERC20Test.sol";

import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {HypTokenTest} from "./HypERC20.t.sol";

import {HypERC4626OwnerCollateral, HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626OwnerCollateral.sol";
import "../../contracts/test/ERC4626/ERC4626Test.sol";

contract HypERC4626OwnerCollateralTest is HypTokenTest {
    using TypeCasts for address;

    uint256 constant DUST_AMOUNT = 1e11;
    HypERC4626OwnerCollateral internal erc20CollateralVaultDeposit;
    ERC4626Test vault;

    function deployErc20CollateralVaultDeposit(
        address _vault
    ) public returns (HypERC4626OwnerCollateral) {
        HypERC4626OwnerCollateral implementation = new HypERC4626OwnerCollateral(
                ERC4626(_vault),
                SCALE,
                address(localMailbox)
            );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC4626Collateral.initialize.selector,
                address(address(noopHook)),
                address(igp),
                address(this)
            )
        );
        localToken = HypERC4626OwnerCollateral(address(proxy));
        return HypERC4626OwnerCollateral(address(localToken));
    }
    function setUp() public override {
        super.setUp();
        vault = new ERC4626Test(address(primaryToken), "Regular Vault", "RV");

        (erc20CollateralVaultDeposit) = deployErc20CollateralVaultDeposit(
            address(vault)
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

    function _localTokenBalanceOf(
        address _account
    ) internal view override returns (uint256) {
        return IERC20(primaryToken).balanceOf(_account);
    }

    function testERC4626VaultDeposit_Initialize_NoncompliantERC20Token()
        public
    {
        NonCompliantERC20Test nonCompliantToken = new NonCompliantERC20Test(); // Has approval() that returns void, instead of bool
        ERC4626Test _vault = new ERC4626Test(
            address(nonCompliantToken),
            "Noncompliant Token Vault",
            "NT"
        );
        deployErc20CollateralVaultDeposit(address(_vault));
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
        uint256 prevBalance = _localTokenBalanceOf(ALICE);
        _handleLocalTransfer(transferAmount);

        assertEq(_localTokenBalanceOf(ALICE), prevBalance + transferAmount);
        assertEq(erc20CollateralVaultDeposit.assetDeposited(), 0);
    }

    function testERC4626VaultDeposit_RemoteTransfer_withdraws_lessShares(
        uint256 rewardAmount
    ) public {
        // @dev a rewardAmount less than the DUST_AMOUNT will round down
        rewardAmount = bound(rewardAmount, DUST_AMOUNT, TOTAL_SUPPLY);

        _transferRoundTripAndIncreaseYields(TRANSFER_AMT, rewardAmount);

        // Check Alice's local token balance
        uint256 prevBalance = _localTokenBalanceOf(ALICE);
        _handleLocalTransfer(TRANSFER_AMT);
        assertEq(_localTokenBalanceOf(ALICE), prevBalance + TRANSFER_AMT);

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

    function testERC4626VaultDeposit_ceilingRounding_reservesMoreShares()
        public
    {
        // This test verifies the mathematical difference between convertToShares (floor)
        // and previewWithdraw (ceiling) rounding when calculating shares for deposits.

        uint256 transferAmount = 100e18;
        uint256 rewardAmount = 1e18;

        // Setup: Transfer from Alice to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransfer(0, transferAmount);

        // Add yield to the vault (increases share value)
        primaryToken.mintTo(address(vault), rewardAmount);

        // Transfer back from Bob to Alice
        vm.prank(BOB);
        remoteToken.transferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );
        _handleLocalTransfer(transferAmount);

        // At this point, we have excess shares due to the yield
        uint256 totalShares = vault.maxRedeem(
            address(erc20CollateralVaultDeposit)
        );
        uint256 assetDeposited = erc20CollateralVaultDeposit.assetDeposited();

        // Calculate what convertToShares (floor rounding) would give us
        uint256 sharesFloor = vault.convertToShares(assetDeposited);

        // Calculate what previewWithdraw (ceiling rounding) gives us
        uint256 sharesCeiling = vault.previewWithdraw(assetDeposited);

        // When there's rounding involved, ceiling should be >= floor
        // and the excess shares should be: totalShares - sharesCeiling
        uint256 excessSharesWithCeiling = totalShares - sharesCeiling;
        uint256 excessSharesWithFloor = totalShares - sharesFloor;

        // Verify the key difference: ceiling rounding calculates more shares to reserve
        // for the deposited assets, which means fewer excess shares to sweep
        assertLe(
            excessSharesWithCeiling,
            excessSharesWithFloor,
            "Ceiling rounding should reserve more shares for deposits"
        );

        // Perform sweep and verify the amount swept is <= excessSharesWithFloor
        // Record logs to capture the event
        vm.recordLogs();
        erc20CollateralVaultDeposit.sweep();

        // Get the logs and extract the ExcessSharesSwept event
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool foundEvent = false;
        uint256 sweptShares;

        for (uint256 i = 0; i < logs.length; i++) {
            // ExcessSharesSwept event signature: ExcessSharesSwept(uint256,uint256)
            if (
                logs[i].topics[0] ==
                keccak256("ExcessSharesSwept(uint256,uint256)")
            ) {
                foundEvent = true;
                // Decode the event data (amount is first parameter, assetsRedeemed is second)
                (sweptShares, ) = abi.decode(logs[i].data, (uint256, uint256));
                break;
            }
        }

        assertTrue(
            foundEvent,
            "ExcessSharesSwept event should have been emitted"
        );
        assertLe(
            sweptShares,
            excessSharesWithFloor,
            "Swept amount should be <= excessSharesWithFloor"
        );
    }

    function testERC4626VaultDeposit_sweep_usesCeilingRounding() public {
        // This test verifies that sweep() correctly sweeps excess shares after yield accrual
        // and leaves no shares behind when assetDeposited is 0.

        uint256 transferAmount = 100e18;
        uint256 rewardAmount = 1e18;

        // Setup: Transfer from Alice to Bob
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransfer(0, transferAmount);

        // Add yield to the vault (increases share value)
        primaryToken.mintTo(address(vault), rewardAmount);

        // Transfer back from Bob to Alice
        vm.prank(BOB);
        remoteToken.transferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );
        _handleLocalTransfer(transferAmount);

        uint256 ownerBalanceBefore = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );

        // Call sweep() which should use previewWithdraw (ceiling rounding)
        erc20CollateralVaultDeposit.sweep();

        uint256 ownerBalanceAfter = primaryToken.balanceOf(
            erc20CollateralVaultDeposit.owner()
        );
        uint256 sweptAmount = ownerBalanceAfter - ownerBalanceBefore;

        // The swept amount should be positive (we did sweep excess shares)
        assertGt(sweptAmount, 0, "Should have swept excess shares");

        // After sweep, we should have no shares remaining (assetDeposited is 0)
        uint256 remainingShares = vault.maxRedeem(
            address(erc20CollateralVaultDeposit)
        );
        assertEq(
            remainingShares,
            0,
            "Should have no shares remaining after sweep with no deposits"
        );
    }

    function testERC4626VaultDeposit_TransferFromSender_CorrectMetadata()
        public
    {
        remoteToken = HypERC20(
            address(
                new HypERC4626(DECIMALS, SCALE, address(remoteMailbox), ORIGIN)
            )
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
