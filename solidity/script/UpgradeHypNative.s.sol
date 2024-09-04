// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {AnvilRPC} from "test/AnvilRPC.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {ProxyAdmin} from "contracts/upgrade/ProxyAdmin.sol";

import {HypNative} from "contracts/token/HypNative.sol";
import {IERC20} from "contracts/token/interfaces/IXERC20.sol";

// source .env.<CHAIN>
// forge script ApproveLockbox.s.sol --broadcast --rpc-url localhost:XXXX
contract UpgradeHypNative is Script {
    address payable router = payable(vm.envAddress("ROUTER_ADDRESS"));
    address admin = vm.envAddress("ADMIN_ADDRESS");
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    ITransparentUpgradeableProxy proxy = ITransparentUpgradeableProxy(router);
    ProxyAdmin proxyAdmin = ProxyAdmin(admin);
    HypNative old = HypNative(router);

    function run() external {
        assert(proxyAdmin.getProxyAdmin(proxy) == admin);

        address owner = proxyAdmin.owner();
        address mailbox = address(old.mailbox());

        // vm.startBroadcast(deployerPrivateKey);
        HypNative logic = new HypNative(mailbox);

        vm.startPrank(owner);
        proxyAdmin.upgrade(proxy, address(logic));
        vm.stopPrank();

        // vm.stopBroadcast();

        vm.expectRevert("Initializable: contract is already initialized");
        HypNative(payable(address(proxy))).initialize(
            address(0),
            address(0),
            address(0)
        );

        uint256 amount = 100;
        vm.expectRevert("Native: amount exceeds msg.value");
        HypNative(payable(address(proxy))).transferRemote{value: amount - 1}(
            uint32(0),
            bytes32(0),
            amount,
            bytes(""),
            address(0)
        );
    }
}
