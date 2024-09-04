// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {AnvilRPC} from "test/AnvilRPC.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {ProxyAdmin} from "contracts/upgrade/ProxyAdmin.sol";

import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";

contract UpgradeHypERC20Collateral is Script {
    address payable router = payable(vm.envAddress("ROUTER_ADDRESS"));
    address mailbox = vm.envAddress("MAILBOX_ADDRESS");
    address admin = vm.envAddress("ADMIN_ADDRESS");
    // uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    ITransparentUpgradeableProxy proxy = ITransparentUpgradeableProxy(router);
    ProxyAdmin proxyAdmin = ProxyAdmin(admin);
    HypERC20Collateral old = HypERC20Collateral(router);

    function run() external {
        assert(proxyAdmin.getProxyAdmin(proxy) == admin);
        assert(address(old.mailbox()) != mailbox);

        HypERC20Collateral logic = new HypERC20Collateral(
            address(old.wrappedToken()),
            mailbox
        );

        address owner = proxyAdmin.owner();
        vm.startPrank(owner);
        proxyAdmin.upgrade(proxy, address(logic));
        vm.stopPrank();

        // vm.stopBroadcast();

        assert(address(old.mailbox()) == mailbox);

        vm.expectRevert("Initializable: contract is already initialized");
        HypERC20Collateral(payable(address(proxy))).initialize(
            address(0),
            address(0),
            address(0)
        );
    }
}
