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

import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockHyperlaneEnvironment} from "contracts/mock/MockHyperlaneEnvironment.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {ITokenFee, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CrossCollateralSynthetic} from "contracts/token/CrossCollateralSynthetic.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {ICrossCollateralFee} from "contracts/token/interfaces/ICrossCollateralFee.sol";
import {HypERC20} from "contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";

/// @notice Mock fee contract: fixed percentage fee.
/// Implements both ITokenFee and ICrossCollateralFee. Token is the leg's token
/// (address(synthetic) for a synthetic leg).
contract MockDepositFee is ITokenFee, ICrossCollateralFee {
    address public immutable token;
    uint256 public immutable feeBps;

    constructor(address _token, uint256 _feeBps) {
        token = _token;
        feeBps = _feeBps;
    }

    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (_amount * feeBps) / 10000);
    }

    function quoteTransferRemoteTo(
        uint32,
        bytes32,
        uint256 _amount,
        bytes32 /*_targetRouter*/
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (_amount * feeBps) / 10000);
    }
}

contract CrossCollateralSyntheticTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint32 internal constant ORIGIN = 1;
    uint32 internal constant DESTINATION = 2;

    // 6→18 canonical scaling
    uint256 internal constant SCALE_NUM = 1e12;
    uint256 internal constant SCALE_DEN = 1;
    uint256 internal constant FEE_BPS = 5; // 0.05%

    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant PROXY_ADMIN = address(0x37);
    address internal constant UNAUTHORIZED = address(0x999);

    // Environment
    MockHyperlaneEnvironment internal env;
    MockMailbox internal originMailbox;
    MockMailbox internal destMailbox;

    // Collateral tokens (6 decimals)
    ERC20Test internal originUSDC;
    ERC20Test internal destUSDC;

    // Routers (behind proxies)
    CrossCollateralSynthetic internal synthA; // domain 1, synthetic (Igra USD)
    CrossCollateralSynthetic internal synthB; // domain 2, synthetic
    CrossCollateralRouter internal collatA; // domain 1, USDC collateral
    CrossCollateralRouter internal collatB; // domain 2, USDC collateral

    function setUp() public {
        env = new MockHyperlaneEnvironment(ORIGIN, DESTINATION);
        originMailbox = env.mailboxes(ORIGIN);
        destMailbox = env.mailboxes(DESTINATION);

        originUSDC = new ERC20Test("USD Coin", "USDC", 0, 6);
        destUSDC = new ERC20Test("USD Coin", "USDC", 0, 6);

        // Synthetic legs: A mints 10M initial supply to deployer (this), B starts empty
        synthA = _deploySynthetic(
            address(originMailbox),
            10_000_000e6,
            "Igra USD",
            "igUSD"
        );
        synthB = _deploySynthetic(address(destMailbox), 0, "Igra USD", "igUSD");

        // Collateral legs
        collatA = _deployCollateral(
            address(originUSDC),
            address(originMailbox)
        );
        collatB = _deployCollateral(address(destUSDC), address(destMailbox));

        // ---- Mutually enroll every peer on every router ----
        // synthA (ORIGIN): collatA(local), synthB, collatB
        _enroll(
            synthA,
            _domains(ORIGIN, DESTINATION, DESTINATION),
            _routers(address(collatA), address(synthB), address(collatB))
        );
        // collatA (ORIGIN): synthA(local), synthB, collatB
        _enroll(
            collatA,
            _domains(ORIGIN, DESTINATION, DESTINATION),
            _routers(address(synthA), address(synthB), address(collatB))
        );
        // synthB (DESTINATION): collatB(local), synthA, collatA
        _enroll(
            synthB,
            _domains(DESTINATION, ORIGIN, ORIGIN),
            _routers(address(collatB), address(synthA), address(collatA))
        );
        // collatB (DESTINATION): synthB(local), synthA, collatA
        _enroll(
            collatB,
            _domains(DESTINATION, ORIGIN, ORIGIN),
            _routers(address(synthB), address(synthA), address(collatA))
        );

        // ---- Fund collateral legs ----
        originUSDC.mintTo(address(collatA), 1_000_000e6);
        destUSDC.mintTo(address(collatB), 1_000_000e6);

        // ---- Fund users ----
        synthA.transfer(ALICE, 100_000e6);
        originUSDC.mintTo(ALICE, 100_000e6);
        originUSDC.mintTo(BOB, 100_000e6);

        vm.prank(ALICE);
        originUSDC.approve(address(collatA), type(uint256).max);
    }

    // ============ 1. synthetic → collateral cross-chain ============

    function test_syntheticToCollateral_crossChain_burnsAndReleases() public {
        uint256 amount = 1000e6;
        uint256 aliceSynthBefore = synthA.balanceOf(ALICE);
        uint256 synthSupplyBefore = synthA.totalSupply();
        uint256 bobUSDCBefore = destUSDC.balanceOf(BOB);

        vm.prank(ALICE);
        synthA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(collatB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(synthA.balanceOf(ALICE), aliceSynthBefore - amount);
        assertEq(synthA.totalSupply(), synthSupplyBefore - amount);
        assertEq(destUSDC.balanceOf(BOB), bobUSDCBefore + amount);
    }

    // ============ 2. collateral → synthetic cross-chain ============

    function test_collateralToSynthetic_crossChain_pullsAndMints() public {
        uint256 amount = 1000e6;
        uint256 aliceUSDCBefore = originUSDC.balanceOf(ALICE);
        uint256 collatBalBefore = originUSDC.balanceOf(address(collatA));
        uint256 bobSynthBefore = synthB.balanceOf(BOB);
        uint256 synthBSupplyBefore = synthB.totalSupply();

        vm.prank(ALICE);
        collatA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(synthB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(originUSDC.balanceOf(ALICE), aliceUSDCBefore - amount);
        assertEq(
            originUSDC.balanceOf(address(collatA)),
            collatBalBefore + amount
        );
        assertEq(synthB.balanceOf(BOB), bobSynthBefore + amount);
        assertEq(synthB.totalSupply(), synthBSupplyBefore + amount);
    }

    // ============ 3. synthetic → synthetic cross-chain ============

    function test_syntheticToSynthetic_crossChain_burnsAndMints() public {
        uint256 amount = 1000e6;
        uint256 aliceSynthBefore = synthA.balanceOf(ALICE);
        uint256 bobSynthBefore = synthB.balanceOf(BOB);

        vm.prank(ALICE);
        synthA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(synthB).addressToBytes32()
        );
        env.processNextPendingMessage();

        assertEq(synthA.balanceOf(ALICE), aliceSynthBefore - amount);
        assertEq(synthB.balanceOf(BOB), bobSynthBefore + amount);
    }

    // ============ 4. same-chain synthetic → collateral ============

    function test_sameChain_syntheticToCollateral() public {
        uint256 amount = 1000e6;
        uint256 aliceSynthBefore = synthA.balanceOf(ALICE);
        uint256 aliceUSDCBefore = originUSDC.balanceOf(ALICE);

        vm.prank(ALICE);
        synthA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(collatA).addressToBytes32()
        );

        assertEq(synthA.balanceOf(ALICE), aliceSynthBefore - amount);
        assertEq(originUSDC.balanceOf(ALICE), aliceUSDCBefore + amount);
    }

    // ============ 5. same-chain collateral → synthetic ============

    function test_sameChain_collateralToSynthetic() public {
        uint256 amount = 1000e6;
        uint256 aliceUSDCBefore = originUSDC.balanceOf(ALICE);
        uint256 aliceSynthBefore = synthA.balanceOf(ALICE);

        vm.prank(ALICE);
        collatA.transferRemoteTo(
            ORIGIN,
            ALICE.addressToBytes32(),
            amount,
            address(synthA).addressToBytes32()
        );

        assertEq(originUSDC.balanceOf(ALICE), aliceUSDCBefore - amount);
        assertEq(synthA.balanceOf(ALICE), aliceSynthBefore + amount);
    }

    // ============ 6. fees on synthetic leg mint to recipient ============

    function test_fees_syntheticLeg_mintsFeeToRecipient() public {
        MockDepositFee fee = new MockDepositFee(address(synthA), FEE_BPS);
        synthA.setFeeRecipient(address(fee));

        uint256 amount = 10000e6;
        uint256 expectedFee = (amount * FEE_BPS) / 10000;
        uint256 aliceBefore = synthA.balanceOf(ALICE);
        uint256 feeBalBefore = synthA.balanceOf(address(fee));

        vm.prank(ALICE);
        synthA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            amount,
            address(synthB).addressToBytes32()
        );

        assertEq(synthA.balanceOf(address(fee)), feeBalBefore + expectedFee);
        assertEq(aliceBefore - synthA.balanceOf(ALICE), amount + expectedFee);
    }

    // ============ 7. quoting ============

    function test_quoteTransferRemoteTo_returnsThreeQuotes() public view {
        Quote[] memory quotes = synthA.quoteTransferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            address(synthB).addressToBytes32()
        );

        assertEq(quotes.length, 3);
        // [0] native gas quote
        assertEq(quotes[0].token, address(0));
        // [1] token amount + fee (no fee recipient set → just amount)
        assertEq(quotes[1].token, address(synthA));
        assertEq(quotes[1].amount, 1000e6);
        // [2] external fee (0)
        assertEq(quotes[2].amount, 0);
    }

    // ============ 8. reject unauthorized in transferRemoteTo ============

    function test_revert_transferRemoteTo_unauthorizedRouter() public {
        vm.prank(ALICE);
        vm.expectRevert("CCR: unauthorized router");
        synthA.transferRemoteTo(
            DESTINATION,
            BOB.addressToBytes32(),
            1000e6,
            UNAUTHORIZED.addressToBytes32()
        );
    }

    // ============ 9. direct-call handle security ============

    function test_revert_handle_directCall_unenrolledCaller() public {
        bytes memory tokenMsg = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e18)
        );
        vm.prank(UNAUTHORIZED);
        vm.expectRevert("CCR: unauthorized router");
        synthA.handle(ORIGIN, UNAUTHORIZED.addressToBytes32(), tokenMsg);
    }

    // ============ 10. reject same-domain via mailbox ============

    function test_revert_handle_sameDomainViaMailbox() public {
        vm.prank(address(originMailbox));
        vm.expectRevert("CCR: same-domain via mailbox not allowed");
        synthA.handle(
            ORIGIN,
            address(synthA).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), uint256(100e18))
        );
    }

    // ============ 11. owner-only router enrollment ============

    function test_revert_enrollRouters_nonOwner() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = DESTINATION;
        routers[0] = UNAUTHORIZED.addressToBytes32();

        vm.prank(UNAUTHORIZED);
        vm.expectRevert("Ownable: caller is not the owner");
        synthA.enrollCrossCollateralRouters(domains, routers);
    }

    // ============ 12. same-chain swap rejects msg.value ============

    function test_revert_sameChain_swap_nonzeroMsgValue() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert("CCR: local transfer no msg.value");
        synthA.transferRemoteTo{value: 1}(
            ORIGIN,
            ALICE.addressToBytes32(),
            1000e6,
            address(collatA).addressToBytes32()
        );
    }

    // ============ Helpers ============

    function _deploySynthetic(
        address _mailbox,
        uint256 _totalSupply,
        string memory _name,
        string memory _symbol
    ) internal returns (CrossCollateralSynthetic) {
        CrossCollateralSynthetic impl = new CrossCollateralSynthetic(
            6,
            SCALE_NUM,
            SCALE_DEN,
            _mailbox
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                _totalSupply,
                _name,
                _symbol,
                address(0), // hook
                address(0), // ism
                address(this) // owner
            )
        );
        return CrossCollateralSynthetic(address(proxy));
    }

    function _deployCollateral(
        address _token,
        address _mailbox
    ) internal returns (CrossCollateralRouter) {
        CrossCollateralRouter impl = new CrossCollateralRouter(
            _token,
            SCALE_NUM,
            SCALE_DEN,
            _mailbox
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20Collateral.initialize.selector,
                address(0), // hook
                address(0), // ism
                address(this) // owner
            )
        );
        return CrossCollateralRouter(address(proxy));
    }

    function _enroll(
        CrossCollateralSynthetic _router,
        uint32[] memory _domains,
        bytes32[] memory _peers
    ) internal {
        _router.enrollCrossCollateralRouters(_domains, _peers);
    }

    function _enroll(
        CrossCollateralRouter _router,
        uint32[] memory _domains,
        bytes32[] memory _peers
    ) internal {
        _router.enrollCrossCollateralRouters(_domains, _peers);
    }

    function _domains(
        uint32 a,
        uint32 b,
        uint32 c
    ) internal pure returns (uint32[] memory arr) {
        arr = new uint32[](3);
        arr[0] = a;
        arr[1] = b;
        arr[2] = c;
    }

    function _routers(
        address a,
        address b,
        address c
    ) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](3);
        arr[0] = a.addressToBytes32();
        arr[1] = b.addressToBytes32();
        arr[2] = c.addressToBytes32();
    }
}
