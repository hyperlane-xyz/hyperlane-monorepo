// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {L1FluentHypNative} from "../contracts/token/extensions/L1FluentHypNative.sol";
import {HypNative} from "../contracts/token/HypNative.sol";
import {TransparentUpgradeableProxy} from "../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

import "forge-std/Script.sol";

/// @dev Deploys `L1FluentHypNative` behind a fresh `ProxyAdmin` +
///      `TransparentUpgradeableProxy`. Same flow as every other warp route in
///      this repo: impl → proxy → `initialize(hook, ism, owner)`.
///
///      Sign via `cast wallet`:
///        forge script solidity/script/L1FluentHypNative.s.sol:L1FluentHypNativeScript \
///          --rpc-url $SEPOLIA_RPC --account <name> --sender <addr> --broadcast --verify
///
///      After `run()`:
///        1) Gateway owner calls `L1HypNativeGateway.setWarpRoute(<proxy>)`.
///        2) After the peer is deployed, fill `WARP_ROUTE` + `REMOTE_ROUTER`
///           below and run with `--sig "enrollRemote()"`.
contract L1FluentHypNativeScript is Script {
    using TypeCasts for address;

    // ─── Deploy config (Sepolia) ───
    address internal constant MAILBOX =
        0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766;
    address internal constant GATEWAY =
        0xe3f87C557c51b296DbC886De05744f0D52ecBb77;
    address internal constant HOOK = address(0);
    address internal constant ISM = address(0);
    address internal constant OWNER =
        0x18FA4399b515F436E213AF5E5aD3337EbCb6E717;

    // 1:1 — L1 native ETH and L2 native ETH share 18 decimals on Fluent.
    uint256 internal constant SCALE_NUMERATOR = 1;
    uint256 internal constant SCALE_DENOMINATOR = 1;

    // ─── Enroll config (fill after run() + peer deploy) ───
    address internal constant WARP_ROUTE =
        0x6197Dc5A4e021B0C2a67334d94704425F87374A7;
    uint32 internal constant REMOTE_DOMAIN = 421614; // Arbitrum Sepolia
    address internal constant REMOTE_ROUTER =
        0xC5790c39284BBd0a0707c553fE6d782948c11ED8;

    function run() public {
        require(OWNER != address(0), "set OWNER constant");

        vm.startBroadcast();

        L1FluentHypNative impl = new L1FluentHypNative(
            SCALE_NUMERATOR,
            SCALE_DENOMINATOR,
            MAILBOX,
            GATEWAY
        );

        ProxyAdmin proxyAdmin = new ProxyAdmin();

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            address(proxyAdmin),
            abi.encodeCall(HypNative.initialize, (HOOK, ISM, OWNER))
        );

        vm.stopBroadcast();

        console.log("ProxyAdmin            :", address(proxyAdmin));
        console.log("L1FluentHypNative impl:", address(impl));
        console.log("L1FluentHypNative     :", address(proxy));
    }

    function enrollRemote() public {
        require(WARP_ROUTE != address(0), "set WARP_ROUTE constant");
        require(REMOTE_ROUTER != address(0), "set REMOTE_ROUTER constant");

        vm.startBroadcast();
        L1FluentHypNative(payable(WARP_ROUTE)).enrollRemoteRouter(
            REMOTE_DOMAIN,
            REMOTE_ROUTER.addressToBytes32()
        );
        vm.stopBroadcast();
    }
}
