// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {AnvilRPC} from "test/AnvilRPC.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {ProxyAdmin} from "contracts/upgrade/ProxyAdmin.sol";

import {HypXERC20Lockbox} from "contracts/token/extensions/HypXERC20Lockbox.sol";
import {IXERC20Lockbox} from "contracts/token/interfaces/IXERC20Lockbox.sol";
import {IXERC20} from "contracts/token/interfaces/IXERC20.sol";
import {IERC20} from "contracts/token/interfaces/IXERC20.sol";

// source .env.<CHAIN>
// forge script ApproveLockbox.s.sol --broadcast --rpc-url localhost:XXXX
contract ApproveLockbox is Script {
    address router = vm.envAddress("ROUTER_ADDRESS");
    address admin = vm.envAddress("ADMIN_ADDRESS");
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    ITransparentUpgradeableProxy proxy = ITransparentUpgradeableProxy(router);
    HypXERC20Lockbox old = HypXERC20Lockbox(router);
    address lockbox = address(old.lockbox());
    address mailbox = address(old.mailbox());
    ProxyAdmin proxyAdmin = ProxyAdmin(admin);

    function run() external {
        assert(proxyAdmin.getProxyAdmin(proxy) == admin);

        vm.startBroadcast(deployerPrivateKey);
        HypXERC20Lockbox logic = new HypXERC20Lockbox(lockbox, 1, mailbox);
        proxyAdmin.upgradeAndCall(
            proxy,
            address(logic),
            abi.encodeCall(HypXERC20Lockbox.approveLockbox, ())
        );
        vm.stopBroadcast();

        vm.expectRevert("Initializable: contract is already initialized");
        HypXERC20Lockbox(address(proxy)).initialize(
            address(0),
            address(0),
            mailbox
        );
    }
}
