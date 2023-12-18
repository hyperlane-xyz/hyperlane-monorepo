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

        primaryToken.transfer(address(localToken), 1000e18);
        primaryToken.transfer(ALICE, 1000e18);

        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer_deposits_intoVault() public {
        vm.prank(ALICE);
        primaryToken.approve(address(localToken), TRANSFER_AMT);

        // Check vault shares balance before and after transfer
        assertEq(vault.maxRedeem(address(erc20CollateralVaultDeposit)), 0);
        _performRemoteTransfer(0, TRANSFER_AMT);
        assertEq(
            vault.maxRedeem(address(erc20CollateralVaultDeposit)),
            TRANSFER_AMT
        );
    }
}
