// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {ArbitrumOrbitIsm} from "../../contracts/isms/hook/ArbitrumOrbitIsm.sol";

/// @dev Deploys the ISM.
contract ArbitruL2Deployer is Script {
    function run() external {
        vm.createSelectFork("sepolia_arb");
        string memory seed = vm.envString("SEEDPHRASE");
        vm.startBroadcast(vm.deriveKey(seed, 0));
        new ArbitrumOrbitIsm();
        vm.stopBroadcast();
    }
}
