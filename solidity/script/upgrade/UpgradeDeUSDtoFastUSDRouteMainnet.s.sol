// SPDX-License-Identifier: GPL-3.0
pragma solidity >0.8.0;

import "forge-std/Script.sol";

import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract DeployBase is Script {
    function setup() internal {
        // Start broadcast.
        vm.startBroadcast();

        // Read caller information.
        (, address deployer, ) = vm.readCallers();

        ITransparentUpgradeableProxy proxy = ITransparentUpgradeableProxy(
            payable(0x9AD81058c6C3Bf552C9014CB30E824717A0ee21b)
        );

        ProxyAdmin proxyAdmin = ProxyAdmin(
            0x076761865E04846E76BAA5f37eBa7AfeF0a69d40
        );

        proxyAdmin.upgrade(proxy, 0x67f9C8460ab81b357e16D93d3799AD8e90D74B0c);
        vm.stopBroadcast();
    }

    function run() external {
        setup();
    }

    // Exclude from coverage report
    function test() public virtual {}
}
