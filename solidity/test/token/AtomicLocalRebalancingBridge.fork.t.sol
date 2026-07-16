// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AtomicLocalRebalancingBridge} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {ITokenBridge} from "contracts/interfaces/ITokenBridge.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

abstract contract AtomicLocalRebalancingBridgeForkTestBase is Test {
    using SafeERC20 for IERC20;

    AtomicLocalRebalancingBridge internal bridge;
    CrossCollateralRouter internal sourceRouter;
    CrossCollateralRouter internal destinationRouter;
    uint32 internal localDomain;
    address internal rebalancer = makeAddr("rebalancer");

    function _setUpFork(
        string memory rpcAlias,
        uint256 blockNumber,
        IERC20 sourceToken,
        IERC20 destinationToken,
        uint32 localDomain_
    ) internal {
        vm.createSelectFork(vm.rpcUrl(rpcAlias), blockNumber);
        localDomain = localDomain_;

        // Use a real CrossCollateralRouter rebalance flow rather than a mock so
        // the fork test exercises real quote/approval/transferRemote semantics
        // against a live DEX (and the bridge's IRebalanceTargets validation).
        sourceRouter = new CrossCollateralRouter(
            address(sourceToken),
            1,
            1,
            address(new MockMailbox(localDomain))
        );
        bridge = new AtomicLocalRebalancingBridge(
            localDomain,
            address(sourceRouter),
            address(this)
        );
        destinationRouter = new CrossCollateralRouter(
            address(destinationToken),
            1,
            1,
            address(new MockMailbox(localDomain))
        );
        sourceRouter.initialize(address(0), address(0), address(this));
        destinationRouter.initialize(address(0), address(0), address(this));

        sourceRouter.enrollRemoteRouter(
            localDomain,
            bytes32(uint256(uint160(address(destinationRouter))))
        );
        sourceRouter.addBridge(localDomain, bridge);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
    }

    function _approveOutputForBridge(IERC20 destinationToken) internal {
        // forceApprove handles non-standard tokens (e.g. mainnet USDT) whose
        // approve does not return a bool.
        vm.prank(rebalancer);
        destinationToken.forceApprove(address(bridge), type(uint256).max);
    }

    function _approveInputCall(
        IERC20 token,
        address spender,
        uint256 amount
    ) internal pure returns (CallLib.Call memory) {
        return
            CallLib.build(
                address(token),
                0,
                abi.encodeCall(IERC20.approve, (spender, amount))
            );
    }

    function _targetCall(
        address target,
        bytes memory data
    ) internal pure returns (CallLib.Call memory) {
        return CallLib.build(target, 0, data);
    }

    function _topUpCall(
        IERC20 token,
        uint256 amount
    ) internal view returns (CallLib.Call memory) {
        return
            CallLib.build(
                address(token),
                0,
                abi.encodeCall(
                    IERC20.transferFrom,
                    (rebalancer, address(bridge), amount)
                )
            );
    }

    function _assertExactFunding(
        IERC20 destinationToken,
        uint256 requiredDelta,
        uint256 destinationBefore,
        uint256 rebalancerBefore
    ) internal view {
        assertEq(
            destinationToken.balanceOf(address(destinationRouter)) -
                destinationBefore,
            requiredDelta
        );
        assertLe(destinationToken.balanceOf(rebalancer), rebalancerBefore);
        assertEq(destinationToken.balanceOf(address(bridge)), 0);
    }

    function _localRebalance(
        uint256 amountIn,
        CallLib.Call[] memory calls
    ) internal {
        bridge.rebalance(
            localDomain,
            amountIn,
            ITokenBridge(address(sourceRouter)),
            bytes32(uint256(uint160(address(destinationRouter)))),
            abi.encode(calls)
        );
    }
}

contract AtomicLocalRebalancingBridgeEthereumForkTest is
    AtomicLocalRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant UNISWAP_V3_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    uint32 internal constant LOCAL_DOMAIN = 1;
    uint256 internal constant FORK_BLOCK = 22_898_879;

    function setUp() public {
        _setUpFork(
            "mainnet",
            FORK_BLOCK,
            IERC20(USDC),
            IERC20(USDT),
            LOCAL_DOMAIN
        );

        deal(USDC, address(sourceRouter), 1_000e6);
        deal(USDT, rebalancer, 1_000e6);
        _approveOutputForBridge(IERC20(USDT));
    }

    function testFork_uniswapExactInputSingle_fundsDestinationRouterExactly()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 5e6));

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
    }

    function testFork_uniswapExactInputSingle_coversShortfallFromRebalancerCall()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 20e6));

        assertEq(
            IERC20(USDT).balanceOf(address(destinationRouter)) -
                destinationBefore,
            amountIn
        );
        assertLt(IERC20(USDT).balanceOf(rebalancer), rebalancerBefore);
    }

    function testFork_uniswapExactInputSingle_refundsSurplusToRebalancer()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 20e6));

        assertEq(
            IERC20(USDT).balanceOf(address(destinationRouter)) -
                destinationBefore,
            amountIn
        );
        assertGt(IERC20(USDT).balanceOf(rebalancer), rebalancerBefore - 20e6);
    }

    function testFork_uniswapExactInputSingle_revertsWhenOutputBelowRequiredOut()
        public
    {
        uint256 amountIn = 100e6;

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(amountIn, _uniswapCalls(amountIn, 0));
    }

    function _uniswapCalls(
        uint256 amountIn,
        uint256 topUp
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](topUp == 0 ? 2 : 3);
        calls[0] = _approveInputCall(IERC20(USDC), UNISWAP_V3_ROUTER, amountIn);
        calls[1] = _targetCall(
            UNISWAP_V3_ROUTER,
            abi.encodeWithSelector(
                IUniswapV3Router.exactInputSingle.selector,
                IUniswapV3Router.ExactInputSingleParams({
                    tokenIn: USDC,
                    tokenOut: USDT,
                    fee: 500,
                    recipient: address(bridge),
                    deadline: block.timestamp + 1 hours,
                    amountIn: amountIn,
                    amountOutMinimum: 1,
                    sqrtPriceLimitX96: 0
                })
            )
        );
        if (topUp > 0) {
            calls[2] = _topUpCall(IERC20(USDT), topUp);
        }
    }
}

contract AtomicLocalRebalancingBridgeBaseForkTest is
    AtomicLocalRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant AERODROME_ROUTER =
        0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant AERODROME_FACTORY =
        0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    uint32 internal constant LOCAL_DOMAIN = 8453;
    uint256 internal constant FORK_BLOCK = 40_000_000;

    function setUp() public {
        _setUpFork(
            "base",
            FORK_BLOCK,
            IERC20(USDC),
            IERC20(USDT),
            LOCAL_DOMAIN
        );

        deal(USDC, address(sourceRouter), 1_000e6);
        deal(USDT, rebalancer, 1_000e6);
        _approveOutputForBridge(IERC20(USDT));
    }

    function testFork_aerodromeExactInput_fundsDestinationRouterExactly()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](
            1
        );
        routes[0] = IAerodromeRouter.Route({
            from: USDC,
            to: USDT,
            stable: false,
            factory: AERODROME_FACTORY
        });

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        calls[0] = _approveInputCall(IERC20(USDC), AERODROME_ROUTER, amountIn);
        calls[1] = _targetCall(
            AERODROME_ROUTER,
            abi.encodeWithSelector(
                IAerodromeRouter.swapExactTokensForTokens.selector,
                amountIn,
                1,
                routes,
                address(bridge),
                block.timestamp + 1 hours
            )
        );
        calls[2] = _topUpCall(IERC20(USDT), 20e6);

        vm.prank(rebalancer);
        _localRebalance(amountIn, calls);

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
    }
}

interface IUniswapV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

contract AtomicLocalRebalancingBridgeBaseUniswapForwardForkTest is
    AtomicLocalRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant UNISWAP_V3_ROUTER =
        0x2626664c2603336E57B271c5C0b26F421741e481;
    uint32 internal constant LOCAL_DOMAIN = 8453;
    uint256 internal constant FORK_BLOCK = 48_000_000;

    function setUp() public {
        _setUpFork(
            "base",
            FORK_BLOCK,
            IERC20(USDC),
            IERC20(USDT),
            LOCAL_DOMAIN
        );

        deal(USDC, address(sourceRouter), 1_000e6);
        deal(USDT, rebalancer, 1_000e6);
        _approveOutputForBridge(IERC20(USDT));
    }

    function testFork_uniswapExactInputSingle_exactFunding() public {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 0));

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            IERC20(USDT).balanceOf(rebalancer)
        );
    }

    function testFork_uniswapExactInputSingle_surplusRefundedToRebalancer()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 0));

        assertEq(
            IERC20(USDT).balanceOf(address(destinationRouter)) -
                destinationBefore,
            amountIn
        );
        assertGt(IERC20(USDT).balanceOf(rebalancer), rebalancerBefore);
        assertEq(IERC20(USDT).balanceOf(address(bridge)), 0);
    }

    function _uniswapCalls(
        uint256 amountIn,
        uint256 topUp
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](topUp == 0 ? 2 : 3);
        calls[0] = _approveInputCall(IERC20(USDC), UNISWAP_V3_ROUTER, amountIn);
        calls[1] = _uniswapV3Call(USDC, USDT, amountIn);
        if (topUp > 0) {
            calls[2] = _topUpCall(IERC20(USDT), topUp);
        }
    }

    function _uniswapV3Call(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private view returns (CallLib.Call memory) {
        return
            _targetCall(
                UNISWAP_V3_ROUTER,
                abi.encodeCall(
                    IUniswapV3SwapRouter02.exactInputSingle,
                    (
                        IUniswapV3SwapRouter02.ExactInputSingleParams({
                            tokenIn: tokenIn,
                            tokenOut: tokenOut,
                            fee: 100,
                            recipient: address(bridge),
                            amountIn: amountIn,
                            amountOutMinimum: 1,
                            sqrtPriceLimitX96: 0
                        })
                    )
                )
            );
    }
}

contract AtomicLocalRebalancingBridgeBaseUniswapReverseForkTest is
    AtomicLocalRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant UNISWAP_V3_ROUTER =
        0x2626664c2603336E57B271c5C0b26F421741e481;
    uint32 internal constant LOCAL_DOMAIN = 8453;
    uint256 internal constant FORK_BLOCK = 48_000_000;

    function setUp() public {
        _setUpFork(
            "base",
            FORK_BLOCK,
            IERC20(USDT),
            IERC20(USDC),
            LOCAL_DOMAIN
        );

        deal(USDT, address(sourceRouter), 1_000e6);
        deal(USDC, rebalancer, 1_000e6);
        _approveOutputForBridge(IERC20(USDC));
    }

    function testFork_uniswapExactInputSingle_shortfallCoveredByTopUp() public {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDC).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDC).balanceOf(rebalancer);

        vm.prank(rebalancer);
        _localRebalance(amountIn, _uniswapCalls(amountIn, 20e6));

        _assertExactFunding(
            IERC20(USDC),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
        assertLt(IERC20(USDC).balanceOf(rebalancer), rebalancerBefore);
    }

    function testFork_uniswapExactInputSingle_revertsWhenOutputBelowRequired()
        public
    {
        uint256 amountIn = 100e6;

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge
                .InsufficientOutputTokenProduced
                .selector
        );
        _localRebalance(amountIn, _uniswapCalls(amountIn, 0));
    }

    function _uniswapCalls(
        uint256 amountIn,
        uint256 topUp
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](topUp == 0 ? 2 : 3);
        calls[0] = _approveInputCall(IERC20(USDT), UNISWAP_V3_ROUTER, amountIn);
        calls[1] = _uniswapV3Call(USDT, USDC, amountIn);
        if (topUp > 0) {
            calls[2] = _topUpCall(IERC20(USDC), topUp);
        }
    }

    function _uniswapV3Call(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private view returns (CallLib.Call memory) {
        return
            _targetCall(
                UNISWAP_V3_ROUTER,
                abi.encodeCall(
                    IUniswapV3SwapRouter02.exactInputSingle,
                    (
                        IUniswapV3SwapRouter02.ExactInputSingleParams({
                            tokenIn: tokenIn,
                            tokenOut: tokenOut,
                            fee: 100,
                            recipient: address(bridge),
                            amountIn: amountIn,
                            amountOutMinimum: 1,
                            sqrtPriceLimitX96: 0
                        })
                    )
                )
            );
    }
}
