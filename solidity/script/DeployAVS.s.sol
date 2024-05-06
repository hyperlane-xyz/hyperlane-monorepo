// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {IDelegationManager} from "../contracts/interfaces/avs/IDelegationManager.sol";
import {ECDSAStakeRegistry} from "../contracts/avs/ECDSAStakeRegistry.sol";
import {Quorum} from "../contracts/interfaces/avs/IECDSAStakeRegistryEventsAndErrors.sol";
import {HyperlaneServiceManager} from "../contracts/avs/HyperlaneServiceManager.sol";

contract DeployAVS is Script {
    address public avsDirectory;
    IDelegationManager public delegationManager;
    address public paymentCoordinator;

    Quorum quorum;
    uint256 thresholdWeight = 6667;

    function loadEigenlayerAddresses(string targetEnv) external {
        string memory root = vm.projectRoot();
        string memory path = string.concat(
            root,
            "solidity/script/avs/eigenlayer_addresses.json"
        );
        string json = vm.readFile(path);

        avsDirectory = json.readAddress(
            string(abi.encodePacked(".", targetEnv, ".avsDirectory"))
        );
        delegationManager = IDelegationManager(
            json.readAddress(
                string(abi.encodePacked(".", targetEnv, ".delegationManager"))
            )
        );
        paymentCoordinator = json.readAddress(
            string(abi.encodePacked(".", targetEnv, ".paymentCoordinator"))
        );
    }

    function run() external {
        vm.startBroadcast();

        loadEigenlayerAddresses();

        ECDSAStakeRegistry stakeRegistry = new ECDSAStakeRegistry(
            delegationManager
        );
        HyperlaneServiceManager hsm = new HyperlaneServiceManager(
            avsDirectory,
            address(stakeRegistry),
            paymentCoordinator,
            address(delegationManager)
        );

        stakeRegistry.initialize(address(hsm), thresholdWeight, quorum);

        vm.stopBroadcast();
    }
}
