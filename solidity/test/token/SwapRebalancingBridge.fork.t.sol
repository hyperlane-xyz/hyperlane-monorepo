// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapRebalancingBridge} from "contracts/token/SwapRebalancingBridge.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {SwapCall} from "contracts/token/interfaces/ISwapRebalancingBridge.sol";

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

contract MockForkRouter {
    IERC20 public immutable wrappedToken;
    uint32 public immutable localDomain;
    uint256 public immutable scaleNumerator;
    uint256 public immutable scaleDenominator;

    mapping(uint32 => bytes32) public routers;

    constructor(
        IERC20 _token,
        uint32 _localDomain,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator
    ) {
        wrappedToken = _token;
        localDomain = _localDomain;
        scaleNumerator = _scaleNumerator;
        scaleDenominator = _scaleDenominator;
    }

    function token() external view returns (address) {
        return address(wrappedToken);
    }

    function setPrimaryRouter(uint32 domain, address router) external {
        routers[domain] = bytes32(uint256(uint160(router)));
    }

    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            domain,
            bytes32(0),
            collateralAmount
        );
        wrappedToken.approve(address(bridge), quotes[1].amount);
        bridge.transferRemote(domain, bytes32(0), collateralAmount);
    }
}

abstract contract SwapRebalancingBridgeForkTestBase is Test {
    SwapRebalancingBridge internal bridge;
    MockForkRouter internal sourceRouter;
    MockForkRouter internal destinationRouter;
    address internal rebalancer = makeAddr("rebalancer");

    function _setUpFork(
        string memory rpcAlias,
        IERC20 sourceToken,
        IERC20 destinationToken,
        uint32 localDomain
    ) internal {
        vm.createSelectFork(vm.rpcUrl(rpcAlias));

        bridge = new SwapRebalancingBridge();
        sourceRouter = new MockForkRouter(sourceToken, localDomain, 1, 1);
        destinationRouter = new MockForkRouter(
            destinationToken,
            localDomain,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(localDomain, address(destinationRouter));

        bridge.setAuthorizedRebalancer(rebalancer, true);
    }

    function _assertExactFunding(
        IERC20 destinationToken,
        uint256 requiredOut,
        uint256 destinationBefore,
        uint256 rebalancerBefore
    ) internal view {
        assertEq(
            destinationToken.balanceOf(address(destinationRouter)) -
                destinationBefore,
            requiredOut
        );
        assertLe(destinationToken.balanceOf(rebalancer), rebalancerBefore);
    }
}

contract SwapRebalancingBridgeEthereumForkTest is
    SwapRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant UNISWAP_V3_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    uint32 internal constant LOCAL_DOMAIN = 1;

    function setUp() public {
        _setUpFork("mainnet", IERC20(USDC), IERC20(USDT), LOCAL_DOMAIN);

        bridge.setTarget(UNISWAP_V3_ROUTER, true);
        bridge.setAllowanceTarget(UNISWAP_V3_ROUTER, true);

        deal(USDC, address(sourceRouter), 1_000e6);
        deal(USDT, rebalancer, 1_000e6);
        vm.prank(rebalancer);
        SafeERC20.forceApprove(
            IERC20(USDT),
            address(bridge),
            type(uint256).max
        );
    }

    function testFork_uniswapExactInputSingle_fundsDestinationRouterExactly()
        public
    {
        uint256 amountIn = 100e6;
        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        SwapCall[] memory swapCalls = new SwapCall[](1);
        swapCalls[0] = SwapCall({
            target: UNISWAP_V3_ROUTER,
            allowanceTarget: UNISWAP_V3_ROUTER,
            data: abi.encodeWithSelector(
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
        });

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            amountIn,
            1,
            block.timestamp + 1 hours,
            swapCalls
        );

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
    }
}

contract SwapRebalancingBridgeBaseForkTest is
    SwapRebalancingBridgeForkTestBase
{
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant AERODROME_ROUTER =
        0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant AERODROME_FACTORY =
        0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    uint32 internal constant LOCAL_DOMAIN = 8453;

    function setUp() public {
        _setUpFork("base", IERC20(USDC), IERC20(USDT), LOCAL_DOMAIN);

        bridge.setTarget(AERODROME_ROUTER, true);
        bridge.setAllowanceTarget(AERODROME_ROUTER, true);

        deal(USDC, address(sourceRouter), 1_000e6);
        deal(USDT, rebalancer, 1_000e6);
        vm.prank(rebalancer);
        SafeERC20.forceApprove(
            IERC20(USDT),
            address(bridge),
            type(uint256).max
        );
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

        SwapCall[] memory swapCalls = new SwapCall[](1);
        swapCalls[0] = SwapCall({
            target: AERODROME_ROUTER,
            allowanceTarget: AERODROME_ROUTER,
            data: abi.encodeWithSelector(
                IAerodromeRouter.swapExactTokensForTokens.selector,
                amountIn,
                1,
                routes,
                address(bridge),
                block.timestamp + 1 hours
            )
        });

        vm.prank(rebalancer);
        bridge.executeRebalance(
            address(sourceRouter),
            address(destinationRouter),
            amountIn,
            1,
            block.timestamp + 1 hours,
            swapCalls
        );

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
    }
}
