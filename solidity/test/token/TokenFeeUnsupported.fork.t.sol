// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {HypFiatToken} from "../../contracts/token/extensions/HypFiatToken.sol";
import {HypXERC20} from "../../contracts/token/extensions/HypXERC20.sol";
import {HypXERC20Lockbox} from "../../contracts/token/extensions/HypXERC20Lockbox.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {IFiatToken} from "../../contracts/token/interfaces/IFiatToken.sol";
import {IXERC20} from "../../contracts/token/interfaces/IXERC20.sol";
import {IXERC20Lockbox} from "../../contracts/token/interfaces/IXERC20Lockbox.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";

interface ICircleFiatToken is IFiatToken {
    function masterMinter() external view returns (address);

    function configureMinter(
        address minter,
        uint256 minterAllowedAmount
    ) external returns (bool);
}

abstract contract TokenFeeUnsupportedForkTest is Test {
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    MockMailbox internal localMailbox;

    function _setUpMailboxes() internal {
        localMailbox = new MockMailbox(ORIGIN);
        MockMailbox remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
    }

    function _configureUnsupportedTokenFee(
        TokenRouter router,
        uint256 fee,
        uint256 amount
    ) internal returns (LinearFee feeContract) {
        feeContract = new LinearFee(
            router.token(),
            fee,
            amount / 2,
            address(this)
        );
        router.setFeeRecipient(address(feeContract));
        router.enrollRemoteRouter(
            DESTINATION,
            address(0xBEEF).addressToBytes32()
        );

        vm.expectRevert("TokenRouter: token fees unsupported");
        router.feeRecipient();
        vm.expectRevert("TokenRouter: token fees unsupported");
        router.quoteTransferRemote(DESTINATION, BOB.addressToBytes32(), amount);
        vm.expectRevert("TokenRouter: token fees unsupported");
        router.transferRemote(DESTINATION, BOB.addressToBytes32(), amount);

        router.setFeeRecipient(address(0));
        assertEq(router.feeRecipient(), address(0));
        assertEq(
            router
            .quoteTransferRemote(DESTINATION, BOB.addressToBytes32(), amount)[1]
                .amount,
            amount
        );
    }

    function _nativeFee(
        TokenRouter router,
        uint256 amount
    ) internal view returns (uint256) {
        return
            router
            .quoteTransferRemote(DESTINATION, BOB.addressToBytes32(), amount)[0]
                .amount;
    }
}

contract HypERC4626CollateralTokenFeeUnsupportedForkTest is
    TokenFeeUnsupportedForkTest
{
    address internal constant SDAI = 0x83F20F44975D03b1b09e64809B757c47f942BEeA;
    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant FEE = 1e18;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), 22_898_879);
        _setUpMailboxes();
    }

    function testTokenFeeRequiresRemoval() public {
        IERC20 dai = IERC20(DAI);
        ERC4626 sDai = ERC4626(SDAI);
        HypERC4626Collateral router = new HypERC4626Collateral(
            sDai,
            1,
            1,
            address(localMailbox)
        );
        router.initialize(address(0), address(0), address(this));
        LinearFee feeContract = _configureUnsupportedTokenFee(
            router,
            FEE,
            AMOUNT
        );

        deal(DAI, ALICE, AMOUNT, true);
        uint256 expectedShares = sDai.previewDeposit(AMOUNT);
        uint256 nativeFee = _nativeFee(router, AMOUNT);
        vm.deal(ALICE, nativeFee);

        vm.startPrank(ALICE);
        dai.approve(address(router), AMOUNT);
        router.transferRemote{value: nativeFee}(
            DESTINATION,
            TypeCasts.addressToBytes32(BOB),
            AMOUNT
        );
        vm.stopPrank();

        assertEq(dai.balanceOf(ALICE), 0);
        assertEq(dai.balanceOf(address(feeContract)), 0);
        assertEq(sDai.balanceOf(address(feeContract)), 0);
        assertEq(sDai.balanceOf(address(router)), expectedShares);
    }
}

contract HypFiatTokenTokenFeeUnsupportedForkTest is
    TokenFeeUnsupportedForkTest
{
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 internal constant AMOUNT = 100e6;
    uint256 internal constant FEE = 1e6;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), 22_898_879);
        _setUpMailboxes();
    }

    function testTokenFeeRequiresRemoval() public {
        ICircleFiatToken usdc = ICircleFiatToken(USDC);
        HypFiatToken router = new HypFiatToken(
            USDC,
            1,
            1,
            address(localMailbox)
        );
        LinearFee feeContract = _configureUnsupportedTokenFee(
            router,
            FEE,
            AMOUNT
        );

        uint256 minterAllowance = 1;
        vm.prank(usdc.masterMinter());
        assertTrue(usdc.configureMinter(address(router), minterAllowance));

        deal(USDC, ALICE, AMOUNT, true);
        uint256 totalSupplyBefore = usdc.totalSupply();
        uint256 nativeFee = _nativeFee(router, AMOUNT);
        vm.deal(ALICE, nativeFee);

        vm.startPrank(ALICE);
        usdc.approve(address(router), AMOUNT);
        router.transferRemote{value: nativeFee}(
            DESTINATION,
            TypeCasts.addressToBytes32(BOB),
            AMOUNT
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(ALICE), 0);
        assertEq(usdc.balanceOf(address(feeContract)), 0);
        assertEq(usdc.totalSupply(), totalSupplyBefore - AMOUNT);
        assertEq(usdc.minterAllowance(address(router)), minterAllowance);
    }
}

contract HypXERC20TokenFeeUnsupportedForkTest is TokenFeeUnsupportedForkTest {
    address internal constant EZETH =
        0x2416092f143378750bb29b79eD961ab195CcEea5;
    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant FEE = 1e18;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"));
        _setUpMailboxes();
    }

    function testTokenFeeRequiresRemoval() public {
        IXERC20 ezEth = IXERC20(EZETH);
        HypXERC20 router = new HypXERC20(EZETH, 1, 1, address(localMailbox));
        LinearFee feeContract = _configureUnsupportedTokenFee(
            router,
            FEE,
            AMOUNT
        );

        vm.startPrank(ezEth.owner());
        ezEth.setLimits(address(this), AMOUNT, 0);
        ezEth.setLimits(address(router), 0, AMOUNT);
        vm.stopPrank();
        ezEth.mint(ALICE, AMOUNT);

        uint256 burnLimitBefore = ezEth.burningCurrentLimitOf(address(router));
        uint256 totalSupplyBefore = ezEth.totalSupply();
        uint256 nativeFee = _nativeFee(router, AMOUNT);
        vm.deal(ALICE, nativeFee);

        vm.startPrank(ALICE);
        IERC20(EZETH).approve(address(router), AMOUNT);
        router.transferRemote{value: nativeFee}(
            DESTINATION,
            TypeCasts.addressToBytes32(BOB),
            AMOUNT
        );
        vm.stopPrank();

        assertEq(ezEth.balanceOf(ALICE), 0);
        assertEq(ezEth.balanceOf(address(feeContract)), 0);
        assertEq(ezEth.totalSupply(), totalSupplyBefore - AMOUNT);
        assertEq(
            ezEth.burningCurrentLimitOf(address(router)),
            burnLimitBefore - AMOUNT
        );
    }
}

contract HypXERC20LockboxTokenFeeUnsupportedForkTest is
    TokenFeeUnsupportedForkTest
{
    address internal constant LOCKBOX =
        0xC8140dA31E6bCa19b287cC35531c2212763C2059;
    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant FEE = 1e18;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), 22_898_879);
        _setUpMailboxes();
    }

    function testTokenFeeRequiresRemoval() public {
        IXERC20Lockbox lockbox = IXERC20Lockbox(LOCKBOX);
        IERC20 underlying = lockbox.ERC20();
        IXERC20 xerc20 = lockbox.XERC20();
        HypXERC20Lockbox router = new HypXERC20Lockbox(
            LOCKBOX,
            1,
            1,
            address(localMailbox)
        );
        LinearFee feeContract = _configureUnsupportedTokenFee(
            router,
            FEE,
            AMOUNT
        );

        vm.prank(xerc20.owner());
        xerc20.setLimits(address(router), 0, AMOUNT);
        deal(address(underlying), ALICE, AMOUNT, true);

        uint256 lockboxBalanceBefore = underlying.balanceOf(LOCKBOX);
        uint256 burnLimitBefore = xerc20.burningCurrentLimitOf(address(router));
        uint256 nativeFee = _nativeFee(router, AMOUNT);
        vm.deal(ALICE, nativeFee);

        vm.startPrank(ALICE);
        underlying.approve(address(router), AMOUNT);
        router.transferRemote{value: nativeFee}(
            DESTINATION,
            TypeCasts.addressToBytes32(BOB),
            AMOUNT
        );
        vm.stopPrank();

        assertEq(underlying.balanceOf(ALICE), 0);
        assertEq(underlying.balanceOf(address(feeContract)), 0);
        assertEq(underlying.balanceOf(LOCKBOX), lockboxBalanceBefore + AMOUNT);
        assertEq(xerc20.balanceOf(address(router)), 0);
        assertEq(
            xerc20.burningCurrentLimitOf(address(router)),
            burnLimitBefore - AMOUNT
        );
    }
}
