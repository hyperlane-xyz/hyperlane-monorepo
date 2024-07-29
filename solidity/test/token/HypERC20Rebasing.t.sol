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

import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {MockERC4626YieldSharing} from "../../contracts/mock/MockERC4626YieldSharing.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {HypTokenTest} from "./HypERC20.t.sol";

import {HypERC20RebasingCollateral} from "../../contracts/token/extensions/HypERC20RebasingCollateral.sol";
import {HypERC20Rebasing} from "../../contracts/token/extensions/HypERC20Rebasing.sol";
import "../../contracts/test/ERC4626/ERC4626Test.sol";

contract HypERC20RebasingCollateralTest is HypTokenTest {
    using TypeCasts for address;

    uint256 constant YIELD = 1e11;
    uint256 constant YIELD_FEES = 1e17; // 10% of yield goes to the vault owner
    HypERC20RebasingCollateral internal rebasingCollateral;
    MockERC4626YieldSharing vault;

    HypERC20RebasingCollateral localRebasingToken;
    HypERC20Rebasing remoteRebasingToken;

    function setUp() public override {
        super.setUp();

        vm.prank(DANIEL); // daniel will be the owner of the vault and accrue yield fees
        vault = new MockERC4626YieldSharing(
            address(primaryToken),
            "Regular Vault",
            "RV",
            YIELD_FEES
        );

        HypERC20RebasingCollateral implementation = new HypERC20RebasingCollateral(
                vault,
                address(localMailbox)
            );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20RebasingCollateral.initialize.selector,
                address(address(noopHook)),
                address(0x0),
                address(this)
            )
        );

        remoteToken = new HypERC20Rebasing(
            primaryToken.decimals(),
            address(remoteMailbox)
        );

        localToken = HypERC20RebasingCollateral(address(proxy));
        remoteToken = HypERC20Rebasing(address(remoteToken));

        localRebasingToken = HypERC20RebasingCollateral(address(proxy));
        remoteRebasingToken = HypERC20Rebasing(address(remoteToken));

        primaryToken.transfer(ALICE, 1000e18);
        _enrollLocalTokenRouter();
        _enrollRemoteTokenRouter();
    }

    function testRemoteTransfer_rebaseAfter() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);

        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);

        localRebasingToken.rebase(DESTINATION);
        remoteMailbox.processNextInboundMessage();
        assertEq(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(yield)
        );
    }

    function testRebaseWithTransfer() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);

        // max 1bp diff
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            2 * transferAmount + _discountedYield(yield),
            1e14,
            0
        );
    }

    function testSyntheticTransfers_withRebase() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);

        vm.prank(BOB);
        remoteToken.transfer(CAROL, transferAmount); // transfer ~100e18 equivalent to CAROL

        // max 1bp diff
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(yield),
            1e14,
            0
        );
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(CAROL),
            transferAmount,
            1e14,
            0
        );
    }

    function testWithdrawalWithoutYield() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        vm.prank(BOB);
        remoteRebasingToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );
        localMailbox.processNextInboundMessage();
        assertEq(primaryToken.balanceOf(BOB), transferAmount);
    }

    function testWithdrawalWithYield() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);

        vm.prank(BOB);
        remoteRebasingToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );

        localMailbox.processNextInboundMessage();

        uint256 _bobBal = primaryToken.balanceOf(BOB);
        uint256 _expectedBal = transferAmount + _discountedYield(yield);

        // BOB gets the yield even though it didn't rebase
        assertApproxEqRelDecimal(_bobBal, _expectedBal, 1e14, 0);
        assertTrue(_bobBal < _expectedBal, "Transfer remote should round down");

        assertEq(vault.accumulatedFees(), yield / 10);
    }

    function testWithdrawalAfterYield() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);
        localRebasingToken.rebase(DESTINATION);
        remoteMailbox.processNextInboundMessage();

        remoteRebasingToken.shareBalanceOf(BOB);
        // Use balance here since it might be off by <1bp
        uint256 bobsBalance = remoteRebasingToken.balanceOf(BOB);
        vm.prank(BOB);
        remoteRebasingToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            bobsBalance
        );
        localMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            primaryToken.balanceOf(BOB),
            transferAmount + _discountedYield(yield),
            1e14,
            0
        );
        assertEq(vault.accumulatedFees(), yield / 10);
    }

    function testWithdrawalInFlight() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        primaryToken.mintTo(CAROL, transferAmount);
        vm.prank(CAROL);
        primaryToken.approve(address(localToken), transferAmount);
        vm.prank(CAROL);
        localToken.transferRemote{value: 0}(
            DESTINATION,
            CAROL.addressToBytes32(),
            transferAmount
        );
        remoteMailbox.processNextInboundMessage();
        // increase collateral in vault
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), 2 * yield);

        localRebasingToken.rebase(DESTINATION);
        vm.prank(CAROL);

        remoteToken.transferRemote(
            ORIGIN,
            CAROL.addressToBytes32(),
            transferAmount
        );
        localMailbox.processNextInboundMessage();

        uint256 claimableFees = vault.getClaimableFees();
        assertApproxEqRelDecimal(
            primaryToken.balanceOf(CAROL),
            transferAmount + yield - (claimableFees / 2),
            1e14,
            0
        );

        // until we process the rebase, the yield is not added on the remote
        assertEq(remoteToken.balanceOf(BOB), transferAmount);
        remoteMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + yield - (claimableFees / 2),
            1e14,
            0
        );
        assertEq(vault.accumulatedFees(), yield / 5); // 0.1 * 2 * yield
    }

    function testWithdrawalAfterDrawdown() public {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);

        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // decrease collateral in vault by 10%
        uint256 drawdown = 5e18;
        primaryToken.burnFrom(address(vault), drawdown);
        localRebasingToken.rebase(DESTINATION);
        remoteMailbox.processNextInboundMessage();

        remoteRebasingToken.shareBalanceOf(BOB);
        // Use balance here since it might be off by <1bp
        uint256 bobsBalance = remoteRebasingToken.balanceOf(BOB);
        vm.prank(BOB);
        remoteRebasingToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            bobsBalance
        );
        localMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            primaryToken.balanceOf(BOB),
            transferAmount - drawdown,
            1e14,
            0
        );
    }

    function testTransfer_withHookSpecified(
        uint256,
        bytes calldata
    ) public override {
        // skip
    }

    function testBenchmark_overheadGasUsage() public override {
        uint256 transferAmount = 100e18;

        vm.prank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // adding rebasing to the overhead
        uint256 yield = 5e18;
        primaryToken.mintTo(address(vault), yield);

        localRebasingToken.rebase(DESTINATION);
        remoteMailbox.processNextInboundMessage();
        assertEq(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(yield)
        );

        vm.prank(address(localMailbox));

        uint256 gasBefore = gasleft();
        localToken.handle(
            DESTINATION,
            address(remoteToken).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), transferAmount)
        );
        uint256 gasAfter = gasleft();
        console.log(
            "Overhead gas usage for withdrawal: %d",
            gasBefore - gasAfter
        );
    }

    // Override to expect different function signature and no balance assertion
    function _performRemoteTransferWithoutExpectation(
        uint256 _msgValue,
        uint256 _amount
    ) internal {
        vm.prank(ALICE);
        localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
        remoteMailbox.processNextInboundMessage();
    }

    function _discountedYield(uint256 _yield) internal view returns (uint256) {
        return _yield - vault.getClaimableFees();
    }
}
