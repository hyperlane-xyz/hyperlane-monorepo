// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {ITokenFee, Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ICrossCollateralFee} from "../../contracts/token/interfaces/ICrossCollateralFee.sol";
import {CrossCollateralRouter} from "../../contracts/token/CrossCollateralRouter.sol";
import {FlashCcrRebalancer} from "../../contracts/rebalancing/FlashCcrRebalancer.sol";

interface IAaveFlashReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IUniswapFlashReceiver {
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata params
    ) external;
}

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
        uint256 amount
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (amount * feeBps) / 10_000);
    }

    function quoteTransferRemoteTo(
        uint32,
        bytes32,
        uint256 amount,
        bytes32
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(token, (amount * feeBps) / 10_000);
    }
}

contract MockQuoteRouter {
    address public immutable token;
    uint32 public immutable localDomain;
    address public immutable quoteToken;
    uint256 public immutable quoteAmount;

    constructor(
        address _token,
        uint32 _localDomain,
        address _quoteToken,
        uint256 _quoteAmount
    ) {
        token = _token;
        localDomain = _localDomain;
        quoteToken = _quoteToken;
        quoteAmount = _quoteAmount;
    }

    function quoteTransferRemoteTo(
        uint32,
        bytes32,
        uint256,
        bytes32
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(quoteToken, quoteAmount);
    }

    function transferRemoteTo(
        uint32,
        bytes32,
        uint256,
        bytes32
    ) external pure returns (bytes32) {
        revert("UNEXPECTED_TRANSFER");
    }
}

contract MockAaveV3Pool {
    using SafeERC20 for IERC20;

    uint256 public premiumBps;

    constructor(uint256 _premiumBps) {
        premiumBps = _premiumBps;
    }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        uint256 premium = (amount * premiumBps) / 10_000;
        IERC20(asset).safeTransfer(receiver, amount);
        require(
            IAaveFlashReceiver(receiver).executeOperation(
                asset,
                amount,
                premium,
                receiver,
                params
            ),
            "AAVE_CALLBACK_FALSE"
        );
        IERC20(asset).safeTransferFrom(
            receiver,
            address(this),
            amount + premium
        );
        require(
            IERC20(asset).balanceOf(address(this)) >= balanceBefore + premium,
            "AAVE_NOT_REPAID"
        );
    }
}

contract MockUniswapV3FlashPool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    uint256 public immutable feeBps;

    constructor(address _token0, address _token1, uint256 _feeBps) {
        token0 = _token0;
        token1 = _token1;
        feeBps = _feeBps;
    }

    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        uint256 token0Before = IERC20(token0).balanceOf(address(this));
        uint256 token1Before = IERC20(token1).balanceOf(address(this));
        uint256 fee0 = (amount0 * feeBps) / 10_000;
        uint256 fee1 = (amount1 * feeBps) / 10_000;

        if (amount0 > 0) IERC20(token0).safeTransfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(recipient, amount1);

        IUniswapFlashReceiver(recipient).uniswapV3FlashCallback(
            fee0,
            fee1,
            data
        );

        require(
            IERC20(token0).balanceOf(address(this)) >= token0Before + fee0,
            "UNI_TOKEN0_NOT_REPAID"
        );
        require(
            IERC20(token1).balanceOf(address(this)) >= token1Before + fee1,
            "UNI_TOKEN1_NOT_REPAID"
        );
    }
}

contract MockAllowanceTarget {
    using SafeERC20 for IERC20;

    function pull(
        address token,
        address from,
        address to,
        uint256 amount
    ) external {
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}

contract MockSwapTarget {
    using SafeERC20 for IERC20;

    bool public stealBeyondAllowance;
    address public reenterTarget;
    bytes public reenterData;

    function setStealBeyondAllowance(bool value) external {
        stealBeyondAllowance = value;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountInUsed,
        uint256 amountOut
    ) external payable {
        if (reenterTarget != address(0)) {
            (bool success, bytes memory returndata) = reenterTarget.call(
                reenterData
            );
            if (!success) {
                assembly {
                    revert(add(returndata, 32), mload(returndata))
                }
            }
        }

        uint256 pullAmount = stealBeyondAllowance
            ? amountInUsed + 1
            : amountInUsed;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), pullAmount);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}

contract MockRoutedSwapTarget {
    using SafeERC20 for IERC20;

    function swapViaAllowanceTarget(
        address allowanceTarget,
        address tokenIn,
        address tokenOut,
        uint256 amountInUsed,
        uint256 amountOut
    ) external payable {
        MockAllowanceTarget(allowanceTarget).pull(
            tokenIn,
            msg.sender,
            address(this),
            amountInUsed
        );
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}

contract FlashCcrRebalancerTest is Test {
    using TypeCasts for address;

    struct BuildParams {
        FlashCcrRebalancer.FlashLoanProvider provider;
        address providerAddress;
        address loanToken;
        uint256 loanAmount;
        address deficitRouter;
        address surplusRouter;
        address surplusToken;
        address deficitToken;
        uint256 maxDebit;
        uint256 ccrAmount;
        uint256 amountInUsed;
        uint256 swapOutput;
        uint256 amountInMax;
        uint256 surplusTopUp;
        uint256 deficitTopUp;
    }

    uint32 internal constant LOCAL_DOMAIN = 1;
    uint256 internal constant USDC_SCALE_NUM = 1e12;
    uint256 internal constant USDC_SCALE_DEN = 1;
    uint256 internal constant USDT_SCALE_NUM = 1;
    uint256 internal constant USDT_SCALE_DEN = 1;

    address internal constant OWNER = address(0xA11CE);
    address internal constant REBALANCER = address(0xB0B);
    address internal constant TOP_UP = address(0xCAFE);
    address internal constant REFUND_TO = address(0xFEE);
    address internal constant UNAUTHORIZED = address(0xBAD);

    MockMailbox internal mailbox;
    ERC20Test internal usdc;
    ERC20Test internal usdt;
    CrossCollateralRouter internal usdcRouter;
    CrossCollateralRouter internal usdtRouter;
    MockAaveV3Pool internal aavePool;
    MockUniswapV3FlashPool internal uniPool;
    MockSwapTarget internal swapTarget;
    FlashCcrRebalancer internal helper;

    function setUp() public {
        mailbox = new MockMailbox(LOCAL_DOMAIN);
        usdc = new ERC20Test("USD Coin", "USDC", 0, 6);
        usdt = new ERC20Test("Tether USD", "USDT", 0, 18);

        usdcRouter = _deployRouter(
            address(usdc),
            USDC_SCALE_NUM,
            USDC_SCALE_DEN
        );
        usdtRouter = _deployRouter(
            address(usdt),
            USDT_SCALE_NUM,
            USDT_SCALE_DEN
        );
        _enrollSameChain(usdcRouter, usdtRouter);
        _enrollSameChain(usdtRouter, usdcRouter);

        usdc.mintTo(address(usdcRouter), 1_000_000e6);
        usdt.mintTo(address(usdtRouter), 1_000_000e18);

        aavePool = new MockAaveV3Pool(5);
        uniPool = new MockUniswapV3FlashPool(address(usdc), address(usdt), 1);
        swapTarget = new MockSwapTarget();
        helper = new FlashCcrRebalancer(OWNER);

        usdc.mintTo(address(aavePool), 10_000_000e6);
        usdc.mintTo(address(uniPool), 10_000_000e6);
        usdt.mintTo(address(uniPool), 10_000_000e18);
        usdc.mintTo(address(swapTarget), 10_000_000e6);
        usdt.mintTo(address(swapTarget), 10_000_000e18);
        usdc.mintTo(TOP_UP, 100_000e6);
        usdt.mintTo(TOP_UP, 100_000e18);

        vm.startPrank(OWNER);
        helper.setRebalancer(REBALANCER, true);
        helper.setFlashLoanProvider(
            FlashCcrRebalancer.FlashLoanProvider.AaveV3,
            address(aavePool),
            true
        );
        helper.setFlashLoanProvider(
            FlashCcrRebalancer.FlashLoanProvider.UniswapV3,
            address(uniPool),
            true
        );
        helper.setSwapTarget(address(swapTarget), true);
        helper.setAllowanceTarget(address(swapTarget), true);
        vm.stopPrank();

        vm.startPrank(TOP_UP);
        usdc.approve(address(helper), type(uint256).max);
        usdt.approve(address(helper), type(uint256).max);
        vm.stopPrank();
    }

    function test_aaveHappyPath_usdcDeficit_usdtSurplus() public {
        uint256 amount = 1000e6;
        uint256 debt = amount + 500000; // 5 bps Aave premium.
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            debt,
            1000e18,
            0,
            0
        );

        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));
        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));
        uint256 poolBefore = usdc.balanceOf(address(aavePool));

        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(
            usdc.balanceOf(address(usdcRouter)),
            usdcRouterBefore + amount
        );
        assertEq(
            usdt.balanceOf(address(usdtRouter)),
            usdtRouterBefore - 1000e18
        );
        assertEq(usdc.balanceOf(address(aavePool)), poolBefore + 500000);
        assertEq(usdc.balanceOf(address(helper)), 0);
        assertEq(usdt.balanceOf(address(helper)), 0);
        assertEq(usdt.balanceOf(REFUND_TO), 0);
        assertEq(usdt.allowance(address(helper), address(swapTarget)), 0);
        assertEq(usdc.allowance(address(helper), address(usdcRouter)), 0);
    }

    function test_uniswapHappyPath_usdcDeficit_usdtSurplus() public {
        uint256 amount = 1000e6;
        uint256 debt = amount + 100000; // 1 bp Uniswap flash fee.
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsUniswap(
            amount,
            amount,
            1000e18,
            debt,
            1000e18,
            0,
            0
        );
        uint256 poolBefore = usdc.balanceOf(address(uniPool));

        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdc.balanceOf(address(uniPool)), poolBefore + 100000);
        assertEq(usdc.balanceOf(address(helper)), 0);
        assertEq(usdt.balanceOf(address(helper)), 0);
    }

    function test_aaveHappyPath_withSeparateSwapAllowanceTarget() public {
        MockAllowanceTarget allowanceTarget = new MockAllowanceTarget();
        MockRoutedSwapTarget routedSwapTarget = new MockRoutedSwapTarget();
        usdc.mintTo(address(routedSwapTarget), 10_000_000e6);

        vm.startPrank(OWNER);
        helper.setSwapTarget(address(routedSwapTarget), true);
        helper.setAllowanceTarget(address(allowanceTarget), true);
        vm.stopPrank();

        uint256 amount = 1000e6;
        uint256 debt = amount + 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            debt,
            1000e18,
            0,
            0
        );
        params.swap.target = address(routedSwapTarget);
        params.swap.allowanceTarget = address(allowanceTarget);
        params.swap.data = abi.encodeCall(
            MockRoutedSwapTarget.swapViaAllowanceTarget,
            (
                address(allowanceTarget),
                address(usdt),
                address(usdc),
                1000e18,
                debt
            )
        );

        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdc.balanceOf(address(helper)), 0);
        assertEq(usdt.balanceOf(address(helper)), 0);
        assertEq(usdt.allowance(address(helper), address(allowanceTarget)), 0);
        assertEq(usdt.allowance(address(helper), address(routedSwapTarget)), 0);
    }

    function test_aaveHappyPath_usdtDeficit_usdcSurplus() public {
        uint256 amount = 1000e18;
        uint256 debt = amount + 0.5e18;
        FlashCcrRebalancer.RebalanceParams
            memory params = _baseReverseParamsAave(
                amount,
                amount,
                1000e6,
                debt,
                1000e6,
                0,
                0
            );
        usdt.mintTo(address(aavePool), 10_000_000e18);
        usdt.mintTo(address(swapTarget), 10_000_000e18);

        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));
        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));

        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(
            usdt.balanceOf(address(usdtRouter)),
            usdtRouterBefore + amount
        );
        assertEq(
            usdc.balanceOf(address(usdcRouter)),
            usdcRouterBefore - 1000e6
        );
        assertEq(usdt.balanceOf(address(helper)), 0);
        assertEq(usdc.balanceOf(address(helper)), 0);
    }

    function test_surplusTokenTopUpUsedAndUnusedRefundedToPayer() public {
        uint256 amount = 1000e6;
        uint256 debt = amount + 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1001e18,
            debt,
            1002e18,
            2e18,
            0
        );
        params.ccr.minSurplusReceived = 1000e18;

        uint256 topUpBefore = usdt.balanceOf(TOP_UP);
        uint256 refundBefore = usdt.balanceOf(REFUND_TO);
        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdt.balanceOf(TOP_UP), topUpBefore - 1e18);
        assertEq(usdt.balanceOf(REFUND_TO), refundBefore);
        assertEq(usdt.balanceOf(address(helper)), 0);
    }

    function test_surplusRouteResidueRefundedToRefundRecipient() public {
        uint256 amount = 1000e6;
        uint256 debt = amount + 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            999e18,
            debt,
            1000e18,
            0,
            0
        );
        params.ccr.minSurplusReceived = 1000e18;

        uint256 refundBefore = usdt.balanceOf(REFUND_TO);
        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdt.balanceOf(REFUND_TO), refundBefore + 1e18);
        assertEq(usdt.balanceOf(address(helper)), 0);
    }

    function test_deficitTokenTopUpCoversRepaymentShortfall() public {
        uint256 amount = 1000e6;
        uint256 debt = amount + 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount,
            1000e18,
            0,
            500000
        );

        uint256 topUpBefore = usdc.balanceOf(TOP_UP);
        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdc.balanceOf(TOP_UP), topUpBefore - 500000);
        assertEq(usdc.balanceOf(address(helper)), 0);
    }

    function test_deficitTokenTopUpCoversCcrFeeAndRepaymentShortfall() public {
        MockDepositFee fee = new MockDepositFee(address(usdc), 5);
        usdcRouter.setFeeRecipient(address(fee));

        uint256 amount = 1000e6;
        uint256 ccrFee = 500000;
        uint256 debt = amount + 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount + ccrFee,
            1000e18,
            amount,
            1000e18,
            0,
            ccrFee + 500000
        );

        uint256 topUpBefore = usdc.balanceOf(TOP_UP);
        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(usdc.balanceOf(TOP_UP), topUpBefore - ccrFee - 500000);
        assertEq(usdc.balanceOf(address(fee)), ccrFee);
        assertEq(usdc.balanceOf(address(aavePool)), 10_000_000e6 + 500000);
        assertEq(usdc.balanceOf(address(helper)), 0);
    }

    function test_revert_ifSwapOutputBelowMinimum_rollsBackCcr() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount,
            1000e18,
            0,
            500000
        );
        params.swap.minAmountOut = amount + 1;

        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));
        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.InsufficientSwapOutput.selector,
                amount,
                amount + 1
            )
        );
        helper.rebalance(params);

        assertEq(usdc.balanceOf(address(usdcRouter)), usdcRouterBefore);
        assertEq(usdt.balanceOf(address(usdtRouter)), usdtRouterBefore);
    }

    function test_revert_ifRepaymentShortfall_rollsBackCcr() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount,
            1000e18,
            0,
            0
        );

        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));
        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));

        vm.prank(REBALANCER);
        vm.expectRevert();
        helper.rebalance(params);

        assertEq(usdc.balanceOf(address(usdcRouter)), usdcRouterBefore);
        assertEq(usdt.balanceOf(address(usdtRouter)), usdtRouterBefore);
    }

    function test_revert_unauthorizedCaller() public {
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );
        vm.prank(UNAUTHORIZED);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.UnauthorizedRebalancer.selector,
                UNAUTHORIZED
            )
        );
        helper.rebalance(params);
    }

    function test_revert_unallowlistedFlashProvider() public {
        MockAaveV3Pool otherPool = new MockAaveV3Pool(5);
        usdc.mintTo(address(otherPool), 10_000_000e6);
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );
        params.loan.providerAddress = address(otherPool);

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.UnauthorizedFlashLoanProvider.selector,
                FlashCcrRebalancer.FlashLoanProvider.AaveV3,
                address(otherPool)
            )
        );
        helper.rebalance(params);
    }

    function test_revert_unallowlistedSwapTarget() public {
        MockSwapTarget otherSwap = new MockSwapTarget();
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );
        params.swap.target = address(otherSwap);
        params.swap.allowanceTarget = address(otherSwap);

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.UnauthorizedSwapTarget.selector,
                address(otherSwap)
            )
        );
        helper.rebalance(params);
    }

    function test_revert_unallowlistedAllowanceTarget() public {
        MockSwapTarget otherSwap = new MockSwapTarget();
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );
        params.swap.allowanceTarget = address(otherSwap);

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.UnauthorizedAllowanceTarget.selector,
                address(otherSwap)
            )
        );
        helper.rebalance(params);
    }

    function test_revert_deadlineExceeded() public {
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );
        params.deadline = block.timestamp - 1;

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.DeadlineExceeded.selector,
                params.deadline
            )
        );
        helper.rebalance(params);
    }

    function test_revert_ccrDebitExceedsMax() public {
        MockDepositFee fee = new MockDepositFee(address(usdc), 5);
        usdcRouter.setFeeRecipient(address(fee));

        uint256 amount = 1000e6;
        uint256 ccrFee = 500000;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount + ccrFee - 1,
            1000e18,
            amount,
            1000e18,
            0,
            ccrFee
        );

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.CcrDebitExceedsMax.selector,
                amount + ccrFee,
                amount + ccrFee - 1
            )
        );
        helper.rebalance(params);
    }

    function test_revert_unsupportedFeeQuoteToken() public {
        MockQuoteRouter quoteRouter = new MockQuoteRouter(
            address(usdc),
            LOCAL_DOMAIN,
            address(usdt),
            500000
        );

        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1001e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            1e6
        );
        params.ccr.deficitRouter = address(quoteRouter);

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.UnsupportedQuoteToken.selector,
                address(usdt),
                500000
            )
        );
        helper.rebalance(params);
    }

    function test_revert_surplusTopUpLimitExceeded() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1001e18,
            amount + 500000,
            1001e18,
            1e18 - 1,
            0
        );
        params.ccr.minSurplusReceived = 1000e18;

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.TopUpLimitExceeded.selector,
                address(usdt),
                1e18,
                1e18 - 1
            )
        );
        helper.rebalance(params);
    }

    function test_revert_deficitTopUpLimitExceeded() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount,
            1000e18,
            0,
            500000 - 1
        );

        vm.prank(REBALANCER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashCcrRebalancer.TopUpLimitExceeded.selector,
                address(usdc),
                500000,
                500000 - 1
            )
        );
        helper.rebalance(params);
    }

    function test_revert_maliciousSwapCannotStealBeyondAllowance() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount + 500000,
            1000e18,
            0,
            0
        );
        swapTarget.setStealBeyondAllowance(true);

        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));
        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));

        vm.prank(REBALANCER);
        vm.expectRevert();
        helper.rebalance(params);

        assertEq(usdc.balanceOf(address(usdcRouter)), usdcRouterBefore);
        assertEq(usdt.balanceOf(address(usdtRouter)), usdtRouterBefore);
    }

    function test_revert_callbackSpoofing() public {
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            1000e6,
            1000e6,
            1000e18,
            1000e6,
            1000e18,
            0,
            0
        );

        vm.expectRevert(FlashCcrRebalancer.CallbackNotActive.selector);
        helper.executeOperation(
            address(usdc),
            1000e6,
            0,
            address(helper),
            abi.encode(params)
        );

        vm.expectRevert(FlashCcrRebalancer.CallbackNotActive.selector);
        helper.uniswapV3FlashCallback(0, 0, abi.encode(params));
    }

    function test_revert_reentrancyFromSwapTarget() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount + 500000,
            1000e18,
            0,
            0
        );
        bytes memory reenterData = abi.encodeCall(
            FlashCcrRebalancer.rebalance,
            (params)
        );
        swapTarget.setReenter(address(helper), reenterData);

        vm.prank(REBALANCER);
        vm.expectRevert();
        helper.rebalance(params);
    }

    function test_revert_nestedAaveCallbackFromSwapTarget() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            1000e18,
            amount + 500000,
            1000e18,
            0,
            0
        );
        bytes memory callbackData = abi.encode(params);
        bytes memory reenterData = abi.encodeCall(
            MockAaveV3Pool.flashLoanSimple,
            (address(helper), address(usdc), amount, callbackData, 0)
        );
        swapTarget.setReenter(address(aavePool), reenterData);

        vm.prank(REBALANCER);
        vm.expectRevert(FlashCcrRebalancer.CallbackAlreadyEntered.selector);
        helper.rebalance(params);
    }

    function test_revert_nestedUniswapCallbackFromSwapTarget() public {
        uint256 amount = 1000e6;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsUniswap(
            amount,
            amount,
            1000e18,
            amount + 100000,
            1000e18,
            0,
            0
        );
        bytes memory callbackData = abi.encode(params);
        bytes memory reenterData = abi.encodeCall(
            MockUniswapV3FlashPool.flash,
            (address(helper), amount, 0, callbackData)
        );
        swapTarget.setReenter(address(uniPool), reenterData);

        vm.prank(REBALANCER);
        vm.expectRevert(FlashCcrRebalancer.CallbackAlreadyEntered.selector);
        helper.rebalance(params);
    }

    function testFuzz_aaveAmounts(uint96 rawAmount, uint16 premiumBps) public {
        uint256 amount = bound(uint256(rawAmount), 1e6, 50_000e6);
        premiumBps = uint16(bound(uint256(premiumBps), 0, 50));
        MockAaveV3Pool fuzzPool = new MockAaveV3Pool(premiumBps);
        usdc.mintTo(address(fuzzPool), 100_000_000e6);
        vm.prank(OWNER);
        helper.setFlashLoanProvider(
            FlashCcrRebalancer.FlashLoanProvider.AaveV3,
            address(fuzzPool),
            true
        );

        uint256 premium = (amount * premiumBps) / 10_000;
        uint256 surplus = amount * 1e12;
        FlashCcrRebalancer.RebalanceParams memory params = _baseParamsAave(
            amount,
            amount,
            surplus,
            amount + premium,
            surplus,
            0,
            premium
        );
        params.loan.providerAddress = address(fuzzPool);

        uint256 usdcRouterBefore = usdc.balanceOf(address(usdcRouter));
        uint256 usdtRouterBefore = usdt.balanceOf(address(usdtRouter));
        vm.prank(REBALANCER);
        helper.rebalance(params);

        assertEq(
            usdc.balanceOf(address(usdcRouter)),
            usdcRouterBefore + amount
        );
        assertEq(
            usdt.balanceOf(address(usdtRouter)),
            usdtRouterBefore - surplus
        );
        assertEq(usdc.balanceOf(address(helper)), 0);
        assertEq(usdt.balanceOf(address(helper)), 0);
    }

    function _deployRouter(
        address token,
        uint256 scaleNum,
        uint256 scaleDen
    ) internal returns (CrossCollateralRouter router) {
        router = new CrossCollateralRouter(
            token,
            scaleNum,
            scaleDen,
            address(mailbox)
        );
        router.initialize(address(0), address(0), address(this));
    }

    function _enrollSameChain(
        CrossCollateralRouter source,
        CrossCollateralRouter target
    ) internal {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = LOCAL_DOMAIN;
        routers[0] = address(target).addressToBytes32();
        source.enrollCrossCollateralRouters(domains, routers);
    }

    function _baseParamsAave(
        uint256 loanAmount,
        uint256 maxDebit,
        uint256 amountInUsed,
        uint256 swapOutput,
        uint256 amountInMax,
        uint256 surplusTopUp,
        uint256 deficitTopUp
    ) internal view returns (FlashCcrRebalancer.RebalanceParams memory params) {
        params = _baseParams(
            BuildParams({
                provider: FlashCcrRebalancer.FlashLoanProvider.AaveV3,
                providerAddress: address(aavePool),
                loanToken: address(usdc),
                loanAmount: loanAmount,
                deficitRouter: address(usdcRouter),
                surplusRouter: address(usdtRouter),
                surplusToken: address(usdt),
                deficitToken: address(usdc),
                maxDebit: maxDebit,
                ccrAmount: loanAmount,
                amountInUsed: amountInUsed,
                swapOutput: swapOutput,
                amountInMax: amountInMax,
                surplusTopUp: surplusTopUp,
                deficitTopUp: deficitTopUp
            })
        );
    }

    function _baseParamsUniswap(
        uint256 loanAmount,
        uint256 maxDebit,
        uint256 amountInUsed,
        uint256 swapOutput,
        uint256 amountInMax,
        uint256 surplusTopUp,
        uint256 deficitTopUp
    ) internal view returns (FlashCcrRebalancer.RebalanceParams memory params) {
        params = _baseParams(
            BuildParams({
                provider: FlashCcrRebalancer.FlashLoanProvider.UniswapV3,
                providerAddress: address(uniPool),
                loanToken: address(usdc),
                loanAmount: loanAmount,
                deficitRouter: address(usdcRouter),
                surplusRouter: address(usdtRouter),
                surplusToken: address(usdt),
                deficitToken: address(usdc),
                maxDebit: maxDebit,
                ccrAmount: loanAmount,
                amountInUsed: amountInUsed,
                swapOutput: swapOutput,
                amountInMax: amountInMax,
                surplusTopUp: surplusTopUp,
                deficitTopUp: deficitTopUp
            })
        );
    }

    function _baseReverseParamsAave(
        uint256 loanAmount,
        uint256 maxDebit,
        uint256 amountInUsed,
        uint256 swapOutput,
        uint256 amountInMax,
        uint256 surplusTopUp,
        uint256 deficitTopUp
    ) internal view returns (FlashCcrRebalancer.RebalanceParams memory params) {
        params = _baseParams(
            BuildParams({
                provider: FlashCcrRebalancer.FlashLoanProvider.AaveV3,
                providerAddress: address(aavePool),
                loanToken: address(usdt),
                loanAmount: loanAmount,
                deficitRouter: address(usdtRouter),
                surplusRouter: address(usdcRouter),
                surplusToken: address(usdc),
                deficitToken: address(usdt),
                maxDebit: maxDebit,
                ccrAmount: loanAmount,
                amountInUsed: amountInUsed,
                swapOutput: swapOutput,
                amountInMax: amountInMax,
                surplusTopUp: surplusTopUp,
                deficitTopUp: deficitTopUp
            })
        );
    }

    function _baseParams(
        BuildParams memory build
    ) internal view returns (FlashCcrRebalancer.RebalanceParams memory params) {
        params.loan = FlashCcrRebalancer.FlashLoanParams({
            provider: build.provider,
            providerAddress: build.providerAddress,
            token: build.loanToken,
            amount: build.loanAmount
        });
        params.ccr = FlashCcrRebalancer.CcrParams({
            deficitRouter: build.deficitRouter,
            surplusRouter: build.surplusRouter,
            targetRouter: build.surplusRouter.addressToBytes32(),
            localDomain: LOCAL_DOMAIN,
            amount: build.ccrAmount,
            maxDeficitTokenDebit: build.maxDebit,
            minSurplusReceived: build.amountInUsed
        });
        params.swap = FlashCcrRebalancer.SwapCall({
            target: address(swapTarget),
            allowanceTarget: address(swapTarget),
            tokenIn: build.surplusToken,
            tokenOut: build.deficitToken,
            amountInMax: build.amountInMax,
            minAmountOut: build.swapOutput,
            value: 0,
            data: abi.encodeCall(
                MockSwapTarget.swapExactOutput,
                (
                    build.surplusToken,
                    build.deficitToken,
                    build.amountInUsed,
                    build.swapOutput
                )
            )
        });
        params.topUp = FlashCcrRebalancer.TopUpParams({
            payer: TOP_UP,
            maxSurplusTokenTopUp: build.surplusTopUp,
            maxDeficitTokenTopUp: build.deficitTopUp
        });
        params.refundTo = REFUND_TO;
        params.deadline = block.timestamp + 1 hours;
    }
}
