// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {MockHook} from "../contracts/mock/MockHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployMockHook is Script {
    function run() external returns (address deployedMockHookAddress) {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        console.log("--- Deploying MockHook ---");
        console.log("Deployer Address:", deployerAddress);
        console.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- Deploy MockHook ---
        MockHook mockHook = new MockHook();
        deployedMockHookAddress = address(mockHook);
        console.log("MockHook deployed at:", deployedMockHookAddress);

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log("  MockHook Address:", deployedMockHookAddress);
        console.log("  Deployer:", deployerAddress);
        console.log(
            "  Note: This is a mock hook that requires no payment and supports any metadata."
        );
        console.log("-----------------------------------------");

        return deployedMockHookAddress;
    }
}
