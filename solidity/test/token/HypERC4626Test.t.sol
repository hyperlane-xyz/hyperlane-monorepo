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
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {HypERC4626} from "../../contracts/token/extensions/HypERC4626.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import "../../contracts/test/ERC4626/ERC4626Test.sol";
import {ProtocolFee} from "../../contracts/hooks/ProtocolFee.sol";

contract HypERC4626CollateralTest is HypTokenTest {
    using TypeCasts for address;

    uint32 internal constant PEER_DESTINATION = 13;
    uint256 constant YIELD = 5e18;
    uint256 constant YIELD_FEES = 1e17; // 10% of yield goes to the vault owner
    uint256 internal transferAmount = 100e18;
    HypERC4626Collateral internal rebasingCollateral;
    MockERC4626YieldSharing vault;

    MockMailbox internal peerMailbox; // mailbox for second synthetic token
    HypERC20 internal peerToken;

    HypERC4626Collateral localRebasingToken;
    HypERC4626 remoteRebasingToken;
    HypERC4626 peerRebasingToken;

    function setUp() public override {
        super.setUp();

        // multi-synthetic setup
        peerMailbox = new MockMailbox(PEER_DESTINATION);
        localMailbox.addRemoteMailbox(PEER_DESTINATION, peerMailbox);
        remoteMailbox.addRemoteMailbox(PEER_DESTINATION, peerMailbox);
        peerMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        peerMailbox.addRemoteMailbox(ORIGIN, localMailbox);
        peerMailbox.setDefaultHook(address(noopHook));
        peerMailbox.setRequiredHook(address(noopHook));

        vm.prank(DANIEL); // daniel will be the owner of the vault and accrue yield fees
        vault = new MockERC4626YieldSharing(
            address(primaryToken),
            "Regular Vault",
            "RV",
            YIELD_FEES
        );

        HypERC4626Collateral implementation = new HypERC4626Collateral(
            vault,
            address(localMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC4626Collateral.initialize.selector,
                address(address(noopHook)),
                address(0x0),
                address(this)
            )
        );
        localToken = HypERC4626Collateral(address(proxy));

        remoteToken = new HypERC4626(
            primaryToken.decimals(),
            address(remoteMailbox),
            localToken.localDomain()
        );
        peerToken = new HypERC4626(
            primaryToken.decimals(),
            address(peerMailbox),
            localToken.localDomain()
        );

        localRebasingToken = HypERC4626Collateral(address(proxy));
        remoteRebasingToken = HypERC4626(address(remoteToken));
        peerRebasingToken = HypERC4626(address(peerToken));

        primaryToken.transfer(ALICE, 1000e18);

        uint32[] memory domains = new uint32[](3);
        domains[0] = ORIGIN;
        domains[1] = DESTINATION;
        domains[2] = PEER_DESTINATION;

        bytes32[] memory addresses = new bytes32[](3);
        addresses[0] = address(localToken).addressToBytes32();
        addresses[1] = address(remoteToken).addressToBytes32();
        addresses[2] = address(peerToken).addressToBytes32();
        _connectRouters(domains, addresses);
    }

    function test_collateralDomain() public view {
        assertEq(
            remoteRebasingToken.collateralDomain(),
            localToken.localDomain()
        );
    }

    function testRemoteTransfer_rebaseAfter() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
        remoteMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(),
            1e14,
            0
        );
    }

    function testRemoteTransfer_rebaseWithCustomHook() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        uint256 FEE = 1e18;
        ProtocolFee customHook = new ProtocolFee(
            FEE,
            FEE,
            address(this),
            address(this)
        );

        localRebasingToken.rebase{value: FEE}(
            DESTINATION,
            StandardHookMetadata.overrideMsgValue(FEE),
            address(customHook)
        );
        assertEq(address(customHook).balance, FEE);
    }

    function testRebaseWithTransfer() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        _performRemoteTransferWithoutExpectation(0, transferAmount);

        // max 1bp diff
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            2 * transferAmount + _discountedYield(),
            1e14,
            0
        );
    }

    function testSyntheticTransfers_withRebase() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        _performRemoteTransferWithoutExpectation(0, transferAmount);

        vm.prank(BOB);
        remoteToken.transfer(CAROL, transferAmount); // transfer ~100e18 equivalent to CAROL

        // max 1bp diff
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(),
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
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );
        localMailbox.processNextInboundMessage();
        assertEq(primaryToken.balanceOf(BOB), transferAmount);
    }

    function testWithdrawalWithYield() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            transferAmount
        );

        localMailbox.processNextInboundMessage();

        uint256 _bobBal = primaryToken.balanceOf(BOB);
        uint256 _expectedBal = transferAmount + _discountedYield();

        // BOB gets the yield even though it didn't rebase
        assertApproxEqRelDecimal(_bobBal, _expectedBal, 1e14, 0);
        assertTrue(_bobBal < _expectedBal, "Transfer remote should round down");

        assertEq(vault.accumulatedFees(), YIELD / 10);
    }

    function testWithdrawalAfterYield() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
        remoteMailbox.processNextInboundMessage();

        // Use balance here since it might be off by <1bp
        uint256 bobsBalance = remoteToken.balanceOf(BOB);
        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
            ORIGIN,
            BOB.addressToBytes32(),
            bobsBalance
        );
        localMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            primaryToken.balanceOf(BOB),
            transferAmount + _discountedYield(),
            1e14,
            0
        );
        assertEq(vault.accumulatedFees(), YIELD / 10);
    }

    function testWithdrawalInFlight() public {
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

        _accrueYield();
        _accrueYield(); // earning 2x yield to be split

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
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
            transferAmount + YIELD - (claimableFees / 2),
            1e14,
            0
        );

        // until we process the rebase, the yield is not added on the remote
        assertEq(remoteToken.balanceOf(BOB), transferAmount);
        remoteMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + YIELD - (claimableFees / 2),
            1e14,
            0
        );
        assertEq(vault.accumulatedFees(), YIELD / 5); // 0.1 * 2 * yield
    }

    function testWithdrawalAfterDrawdown() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        // decrease collateral in vault by 10%
        uint256 drawdown = 5e18;
        primaryToken.burnFrom(address(vault), drawdown);
        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
        remoteMailbox.processNextInboundMessage();

        // Use balance here since it might be off by <1bp
        uint256 bobsBalance = remoteToken.balanceOf(BOB);
        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
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

    function test_exchangeRate_setOnlyByCollateral() public {
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
        remoteMailbox.processNextInboundMessage();

        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
            PEER_DESTINATION,
            BOB.addressToBytes32(),
            transferAmount
        );
        peerMailbox.processNextInboundMessage();

        assertApproxEqRelDecimal(
            remoteRebasingToken.exchangeRate(),
            1045e7,
            1e14,
            0
        ); // 5 * 0.9 = 4.5% yield
        assertEq(peerRebasingToken.exchangeRate(), 1e10); // assertingthat transfers by the synthetic variant don't impact the exchang rate

        localRebasingToken.rebase(PEER_DESTINATION, bytes(""), address(0));
        peerMailbox.processNextInboundMessage();

        assertApproxEqRelDecimal(
            peerRebasingToken.exchangeRate(),
            1045e7,
            1e14,
            0
        ); // asserting that the exchange rate is set finally by the collateral variant
    }

    function test_cyclicTransfers() public {
        // ALICE: local -> remote(BOB)
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0)); // yield is added
        remoteMailbox.processNextInboundMessage();

        // BOB: remote -> peer(BOB) (yield is leftover)
        vm.prank(BOB);
        remoteToken.transferRemote{value: 0}(
            PEER_DESTINATION,
            BOB.addressToBytes32(),
            transferAmount
        );
        peerMailbox.processNextInboundMessage();

        localRebasingToken.rebase(PEER_DESTINATION, bytes(""), address(0));
        peerMailbox.processNextInboundMessage();

        // BOB: peer -> local(CAROL)
        vm.prank(BOB);
        peerToken.transferRemote{value: 0}(
            ORIGIN,
            CAROL.addressToBytes32(),
            transferAmount
        );
        localMailbox.processNextInboundMessage();

        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            _discountedYield(),
            1e14,
            0
        );
        assertEq(peerToken.balanceOf(BOB), 0);
        assertApproxEqRelDecimal(
            primaryToken.balanceOf(CAROL),
            transferAmount,
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
        _performRemoteTransferWithoutExpectation(0, transferAmount);
        assertEq(remoteToken.balanceOf(BOB), transferAmount);

        _accrueYield();

        localRebasingToken.rebase(DESTINATION, bytes(""), address(0));
        remoteMailbox.processNextInboundMessage();
        assertApproxEqRelDecimal(
            remoteToken.balanceOf(BOB),
            transferAmount + _discountedYield(),
            1e14,
            0
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

    // ALICE: local -> remote(BOB)
    function _performRemoteTransferWithoutExpectation(
        uint256 _msgValue,
        uint256 _amount
    ) internal {
        vm.startPrank(ALICE);
        primaryToken.approve(address(localToken), transferAmount);
        localToken.transferRemote{value: _msgValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
        vm.stopPrank();

        remoteMailbox.processNextInboundMessage();
    }

    function _accrueYield() public {
        primaryToken.mintTo(address(vault), YIELD);
    }

    function _discountedYield() internal view returns (uint256) {
        return YIELD - vault.getClaimableFees();
    }
}
