// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import "forge-std/Script.sol";
import "forge-std/StdJson.sol";

import {DeployLib} from "./lib/DeployLib.sol";
import {MultisigIsm} from "../contracts/isms/MultisigIsm.sol";

contract DeployMultisigIsm is Script {
    function run() public {
        // Read all the config we need first so that we ensure valid
        // config before sending any transactions.
        address owner = vm.envAddress("OWNER");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        string[] memory remotes = vm.envString("REMOTES", ",");
        DeployLib.MultisigIsmConfig[] memory configs = DeployLib
            .getMultisigIsmConfigs(vm, remotes);

        vm.startBroadcast(deployerPrivateKey);

        MultisigIsm ism = DeployLib.deployMultisigIsm(configs);
        ism.transferOwnership(owner);
    }
}
