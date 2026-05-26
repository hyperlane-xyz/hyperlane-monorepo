// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {AtomicLocalRebalancingBridge, CallInvariant} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {Quotes} from "contracts/token/libs/Quotes.sol";

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
    using Quotes for Quote[];

    IERC20 public immutable wrappedToken;
    uint32 public immutable localDomain;
    uint256 public immutable scaleNumerator;
    uint256 public immutable scaleDenominator;

    mapping(uint32 => bytes32) public routers;
    mapping(uint32 => bytes32) public allowedRecipient;
    address[] internal _allowedRebalancers;
    mapping(address => bool) public isAllowedRebalancer;

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

    function setRecipient(uint32 domain, address recipient) external {
        allowedRecipient[domain] = bytes32(uint256(uint160(recipient)));
    }

    function approveTokenForBridge(ITokenBridge bridge) external {
        wrappedToken.approve(address(bridge), type(uint256).max);
    }

    function addRebalancer(address rebalancer) external {
        if (!isAllowedRebalancer[rebalancer]) {
            _allowedRebalancers.push(rebalancer);
            isAllowedRebalancer[rebalancer] = true;
        }
    }

    function allowedRebalancers() external view returns (address[] memory) {
        return _allowedRebalancers;
    }

    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable {
        require(isAllowedRebalancer[msg.sender], "MCR: Only Rebalancer");
        bytes32 recipient = allowedRecipient[domain];
        if (recipient == bytes32(0)) {
            recipient = routers[domain];
        }
        Quote[] memory quotes = bridge.quoteTransferRemote(
            domain,
            recipient,
            collateralAmount
        );
        require(
            quotes.extract(address(wrappedToken)) <= collateralAmount,
            "unexpected fees"
        );
        bridge.transferRemote(domain, recipient, collateralAmount);
    }
}

abstract contract AtomicLocalRebalancingBridgeForkTestBase is Test {
    AtomicLocalRebalancingBridge internal bridge;
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

        bridge = new AtomicLocalRebalancingBridge(
            localDomain,
            CallInvariant.RequiredDelta
        );
        sourceRouter = new MockForkRouter(sourceToken, localDomain, 1, 1);
        destinationRouter = new MockForkRouter(
            destinationToken,
            localDomain,
            1,
            1
        );
        sourceRouter.setPrimaryRouter(localDomain, address(destinationRouter));
        sourceRouter.approveTokenForBridge(bridge);
        sourceRouter.addRebalancer(rebalancer);
        sourceRouter.addRebalancer(address(bridge));
    }

    function _approveOutputForBridge(IERC20 destinationToken) internal {
        vm.prank(rebalancer);
        destinationToken.approve(address(bridge), type(uint256).max);
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

    function setUp() public {
        _setUpFork("mainnet", IERC20(USDC), IERC20(USDT), LOCAL_DOMAIN);

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
        bridge.localRebalance(
            address(sourceRouter),
            amountIn,
            _uniswapCalls(amountIn, 5e6)
        );

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
        destinationRouter = new MockForkRouter(
            IERC20(USDT),
            LOCAL_DOMAIN,
            10,
            11
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));

        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            amountIn,
            _uniswapCalls(amountIn, 20e6)
        );

        assertEq(
            IERC20(USDT).balanceOf(address(destinationRouter)) -
                destinationBefore,
            110e6
        );
        assertLt(IERC20(USDT).balanceOf(rebalancer), rebalancerBefore);
    }

    function testFork_uniswapExactInputSingle_refundsSurplusToRebalancer()
        public
    {
        uint256 amountIn = 100e6;
        destinationRouter = new MockForkRouter(
            IERC20(USDT),
            LOCAL_DOMAIN,
            10,
            9
        );
        sourceRouter.setPrimaryRouter(LOCAL_DOMAIN, address(destinationRouter));

        uint256 destinationBefore = IERC20(USDT).balanceOf(
            address(destinationRouter)
        );
        uint256 rebalancerBefore = IERC20(USDT).balanceOf(rebalancer);

        vm.prank(rebalancer);
        bridge.localRebalance(
            address(sourceRouter),
            amountIn,
            _uniswapCalls(amountIn, 0)
        );

        assertEq(
            IERC20(USDT).balanceOf(address(destinationRouter)) -
                destinationBefore,
            90e6
        );
        assertGt(IERC20(USDT).balanceOf(rebalancer), rebalancerBefore);
    }

    function testFork_uniswapExactInputSingle_revertsWhenOutputBelowRequiredOut()
        public
    {
        uint256 amountIn = 100e6;

        vm.prank(rebalancer);
        vm.expectRevert(
            AtomicLocalRebalancingBridge.InsufficientOutput.selector
        );
        bridge.localRebalance(
            address(sourceRouter),
            amountIn,
            _uniswapCalls(amountIn, 0)
        );
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

    function setUp() public {
        _setUpFork("base", IERC20(USDC), IERC20(USDT), LOCAL_DOMAIN);

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
        calls[2] = _topUpCall(IERC20(USDT), 5e6);

        vm.prank(rebalancer);
        bridge.localRebalance(address(sourceRouter), amountIn, calls);

        _assertExactFunding(
            IERC20(USDT),
            amountIn,
            destinationBefore,
            rebalancerBefore
        );
    }
}
