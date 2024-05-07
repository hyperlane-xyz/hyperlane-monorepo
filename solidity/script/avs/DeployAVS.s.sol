// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {IStrategy} from "../../contracts/interfaces/avs/IStrategy.sol";
import {IDelegationManager} from "../../contracts/interfaces/avs/IDelegationManager.sol";
import {ECDSAStakeRegistry} from "../../contracts/avs/ECDSAStakeRegistry.sol";
import {Quorum, StrategyParams} from "../../contracts/interfaces/avs/IECDSAStakeRegistryEventsAndErrors.sol";
import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";

import {TestPaymentCoordinator} from "../../contracts/test/avs/TestPaymentCoordinator.sol";

contract DeployAVS is Script {
    using stdJson for string;

    struct StrategyInfo {
        string name;
        address strategy;
    }

    uint256 deployerPrivateKey;

    address public avsDirectory;
    IDelegationManager public delegationManager;
    address public paymentCoordinator;

    Quorum quorum;
    uint256 thresholdWeight = 6667;

    function _loadEigenlayerAddresses(string memory targetEnv) internal {
        string memory root = vm.projectRoot();
        string memory path = string.concat(
            root,
            "/script/avs/eigenlayer_addresses.json"
        );
        string memory json = vm.readFile(path);

        avsDirectory = json.readAddress(
            string(abi.encodePacked(".", targetEnv, ".avsDirectory"))
        );
        console.log("AVS directory address: ", avsDirectory);
        delegationManager = IDelegationManager(
            json.readAddress(
                string(abi.encodePacked(".", targetEnv, ".delegationManager"))
            )
        );
        // paymentCoordinator = json.readAddress(string(abi.encodePacked(".", targetEnv, ".paymentCoordinator")));
        paymentCoordinator = address(new TestPaymentCoordinator());

        StrategyInfo[] memory strategies = abi.decode(
            vm.parseJson(
                json,
                string(abi.encodePacked(".", targetEnv, ".strategies"))
            ),
            (StrategyInfo[])
        );

        StrategyParams memory strategyParam;

        uint96 totalMultipliers = 10_000;
        uint96 multiplier;

        uint96 strategyCount = uint96(strategies.length);
        for (uint96 i = 0; i < strategyCount; i++) {
            // the multipliers need to add up to 10,000, so we divide the total by the number of strategies for the first n-1 strategies
            // and then the last strategy gets the remainder
            if (i < strategies.length - 1) {
                multiplier = totalMultipliers / uint96(strategyCount);
            } else {
                multiplier =
                    totalMultipliers -
                    multiplier *
                    uint96(strategyCount - 1);
            }
            strategyParam = StrategyParams({
                strategy: IStrategy(strategies[i].strategy),
                multiplier: multiplier
            });
            quorum.strategies.push(strategyParam);
        }
    }

    function run() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        _loadEigenlayerAddresses("holesky");

        vm.startBroadcast(deployerPrivateKey);

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
