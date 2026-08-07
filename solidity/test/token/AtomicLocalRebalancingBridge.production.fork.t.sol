// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {CallLib} from "contracts/middleware/libs/Call.sol";
import {ITokenBridge} from "contracts/interfaces/ITokenBridge.sol";
import {AtomicLocalRebalancingBridge} from "contracts/token/AtomicLocalRebalancingBridge.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";

interface IBaseSwapRouter02 {
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

contract AtomicLocalRebalancingBridgeProductionForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    CrossCollateralRouter internal constant USDC_ROUTER =
        CrossCollateralRouter(0x253821543C24623ecD3ceBCEd704359AF16CF38f);
    CrossCollateralRouter internal constant USDT_ROUTER =
        CrossCollateralRouter(0x7abBb4ea8a5895127500CF0C15830C9Eb9f61F96);
    ProxyAdmin internal constant USDC_PROXY_ADMIN =
        ProxyAdmin(0xB550Da0E2A568B5C29B7FC63d08C8bf4865D1Ffe);
    ProxyAdmin internal constant USDT_PROXY_ADMIN =
        ProxyAdmin(0x08A6b269cEE8CE23950279bC0aFfBCEf93De6DC8);
    address internal constant OWNER =
        0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7;
    address internal constant REBALANCER =
        0xa3948a15e1d0778a7d53268b651B2411AF198FE3;
    address internal constant SWAP_ROUTER =
        0x2626664c2603336E57B271c5C0b26F421741e481;
    uint32 internal constant LOCAL_DOMAIN = 8453;
    uint256 internal constant FORK_BLOCK = 49_665_817;

    AtomicLocalRebalancingBridge internal usdcBridge;
    AtomicLocalRebalancingBridge internal usdtBridge;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("base"), FORK_BLOCK);

        _upgradeRouter(USDC_ROUTER, USDC_PROXY_ADMIN);
        _upgradeRouter(USDT_ROUTER, USDT_PROXY_ADMIN);

        usdcBridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(USDC_ROUTER),
            OWNER
        );
        usdtBridge = new AtomicLocalRebalancingBridge(
            LOCAL_DOMAIN,
            address(USDT_ROUTER),
            OWNER
        );

        _configureDirection(USDC_ROUTER, USDT_ROUTER, usdcBridge);
        _configureDirection(USDT_ROUTER, USDC_ROUTER, usdtBridge);
    }

    function testFork_productionUsdcToUsdtLocalRebalance() public {
        _assertDirectionConfigured(USDC_ROUTER, USDT_ROUTER, usdcBridge);
        _rebalance(
            USDC_ROUTER,
            USDT_ROUTER,
            usdcBridge,
            IERC20(USDC),
            IERC20(USDT)
        );
    }

    function testFork_productionUsdtToUsdcLocalRebalance() public {
        _assertDirectionConfigured(USDT_ROUTER, USDC_ROUTER, usdtBridge);
        _rebalance(
            USDT_ROUTER,
            USDC_ROUTER,
            usdtBridge,
            IERC20(USDT),
            IERC20(USDC)
        );
    }

    function _upgradeRouter(
        CrossCollateralRouter router,
        ProxyAdmin admin
    ) internal {
        CrossCollateralRouter implementation = new CrossCollateralRouter(
            address(router.wrappedToken()),
            router.scaleNumerator(),
            router.scaleDenominator(),
            address(router.mailbox())
        );

        vm.prank(OWNER);
        admin.upgrade(
            ITransparentUpgradeableProxy(payable(address(router))),
            address(implementation)
        );
    }

    function _configureDirection(
        CrossCollateralRouter source,
        CrossCollateralRouter destination,
        AtomicLocalRebalancingBridge bridge
    ) internal {
        bytes32 destinationId = bytes32(uint256(uint160(address(destination))));

        vm.startPrank(OWNER);
        source.addRebalanceTarget(LOCAL_DOMAIN, destinationId);
        source.setRecipient(LOCAL_DOMAIN, destinationId);
        source.addBridge(LOCAL_DOMAIN, bridge);
        source.addRebalancer(REBALANCER);
        source.addRebalancer(address(bridge));
        vm.stopPrank();
    }

    function _assertDirectionConfigured(
        CrossCollateralRouter source,
        CrossCollateralRouter destination,
        AtomicLocalRebalancingBridge bridge
    ) internal view {
        bytes32 destinationId = bytes32(uint256(uint160(address(destination))));

        assertTrue(source.isRebalanceTarget(LOCAL_DOMAIN, destinationId));
        assertEq(source.allowedRecipient(LOCAL_DOMAIN), destinationId);
        assertTrue(source.isAllowedRebalancer(REBALANCER));
        assertTrue(source.isAllowedRebalancer(address(bridge)));
        assertEq(bridge.allowedSourceRouter(), address(source));
        assertEq(bridge.owner(), OWNER);

        address[] memory bridges = source.allowedBridges(LOCAL_DOMAIN);
        assertEq(bridges.length, 1);
        assertEq(bridges[0], address(bridge));
    }

    function _rebalance(
        CrossCollateralRouter source,
        CrossCollateralRouter destination,
        AtomicLocalRebalancingBridge bridge,
        IERC20 sourceToken,
        IERC20 destinationToken
    ) internal {
        uint256 amount = 10e6;
        uint256 topUp = 1e6;
        deal(address(sourceToken), address(source), 100e6);
        deal(address(destinationToken), REBALANCER, topUp);

        vm.prank(REBALANCER);
        destinationToken.approve(address(bridge), topUp);

        uint256 sourceBefore = sourceToken.balanceOf(address(source));
        uint256 destinationBefore = destinationToken.balanceOf(
            address(destination)
        );

        CallLib.Call[] memory calls = new CallLib.Call[](3);
        calls[0] = CallLib.build(
            address(sourceToken),
            0,
            abi.encodeCall(IERC20.approve, (SWAP_ROUTER, amount))
        );
        calls[1] = CallLib.build(
            SWAP_ROUTER,
            0,
            abi.encodeCall(
                IBaseSwapRouter02.exactInputSingle,
                (
                    IBaseSwapRouter02.ExactInputSingleParams({
                        tokenIn: address(sourceToken),
                        tokenOut: address(destinationToken),
                        fee: 100,
                        recipient: address(bridge),
                        amountIn: amount,
                        amountOutMinimum: 1,
                        sqrtPriceLimitX96: 0
                    })
                )
            )
        );
        calls[2] = CallLib.build(
            address(destinationToken),
            0,
            abi.encodeCall(
                IERC20.transferFrom,
                (REBALANCER, address(bridge), topUp)
            )
        );

        vm.prank(REBALANCER);
        bridge.rebalance(
            LOCAL_DOMAIN,
            amount,
            ITokenBridge(address(source)),
            bytes32(uint256(uint160(address(destination)))),
            abi.encode(calls)
        );

        assertEq(sourceToken.balanceOf(address(source)), sourceBefore - amount);
        assertEq(
            destinationToken.balanceOf(address(destination)),
            destinationBefore + amount
        );
        assertEq(sourceToken.balanceOf(address(bridge)), 0);
        assertEq(destinationToken.balanceOf(address(bridge)), 0);
    }
}
