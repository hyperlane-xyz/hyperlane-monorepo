// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {HypNative} from "../contracts/token/HypNative.sol";
import {TransparentUpgradeableProxy} from "../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

import "forge-std/Script.sol";

/// @dev Deploys a stock HypNative on Arbitrum Sepolia as the peer of
///      L1FluentHypNative on Sepolia.
///
///      Sign via `cast wallet`:
///        forge script solidity/script/ArbSepoliaHypNative.s.sol:ArbSepoliaHypNativeScript \
///          --rpc-url $ARB_SEPOLIA_RPC --account <name> --sender <addr> --broadcast --verify
///
///      After `run()`:
///        1) Fill `WARP_ROUTE` with the proxy from run() and call enrollRemote().
///        2) On the Sepolia side, also enroll this proxy back via
///           L1FluentHypNative.s.sol:enrollRemote().
contract ArbSepoliaHypNativeScript is Script {
    using TypeCasts for address;

    // ─── Deploy config (Arbitrum Sepolia) ───
    address internal constant MAILBOX =
        0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8;
    address internal constant HOOK = address(0);
    address internal constant ISM = address(0);
    address internal constant OWNER =
        0x18FA4399b515F436E213AF5E5aD3337EbCb6E717;

    // 1:1 — both legs are 18-decimal native ETH.
    uint256 internal constant SCALE_NUMERATOR = 1;
    uint256 internal constant SCALE_DENOMINATOR = 1;

    // ─── Enroll config ───
    address internal constant WARP_ROUTE =
        0xC5790c39284BBd0a0707c553fE6d782948c11ED8;
    uint32 internal constant REMOTE_DOMAIN = 11155111; // Sepolia
    address internal constant REMOTE_ROUTER =
        0x6197Dc5A4e021B0C2a67334d94704425F87374A7; // L1FluentHypNative on Sepolia

    function run() public {
        require(OWNER != address(0), "set OWNER constant");

        vm.startBroadcast();

        HypNative impl = new HypNative(
            SCALE_NUMERATOR,
            SCALE_DENOMINATOR,
            MAILBOX
        );

        ProxyAdmin proxyAdmin = new ProxyAdmin();

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            address(proxyAdmin),
            abi.encodeCall(HypNative.initialize, (HOOK, ISM, OWNER))
        );

        vm.stopBroadcast();

        console.log("ProxyAdmin     :", address(proxyAdmin));
        console.log("HypNative impl :", address(impl));
        console.log("HypNative      :", address(proxy));
    }

    function enrollRemote() public {
        require(WARP_ROUTE != address(0), "set WARP_ROUTE constant");

        vm.startBroadcast();
        HypNative(payable(WARP_ROUTE)).enrollRemoteRouter(
            REMOTE_DOMAIN,
            REMOTE_ROUTER.addressToBytes32()
        );
        vm.stopBroadcast();
    }
}
