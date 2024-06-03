// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {IStrategy} from "../../contracts/interfaces/avs/vendored/IStrategy.sol";
import {IAVSDirectory} from "../../contracts/interfaces/avs/vendored/IAVSDirectory.sol";
import {IPaymentCoordinator} from "../../contracts/interfaces/avs/vendored/IPaymentCoordinator.sol";
import {IDelegationManager} from "../../contracts/interfaces/avs/vendored/IDelegationManager.sol";

import {ProxyAdmin} from "../../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ECDSAStakeRegistry} from "../../contracts/avs/ECDSAStakeRegistry.sol";
import {Quorum, StrategyParams} from "../../contracts/interfaces/avs/vendored/IECDSAStakeRegistryEventsAndErrors.sol";
import {ECDSAServiceManagerBase} from "../../contracts/avs/ECDSAServiceManagerBase.sol";
import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";

import {TestPaymentCoordinator} from "../../contracts/test/avs/TestPaymentCoordinator.sol";

contract DeployAVS is Script {
    using stdJson for string;

    struct StrategyInfo {
        string name;
        address strategy;
    }

    uint256 deployerPrivateKey;

    ProxyAdmin public proxyAdmin;
    IAVSDirectory public avsDirectory;
    IPaymentCoordinator public paymentCoordinator;
    IDelegationManager public delegationManager;

    Quorum quorum;
    uint256 thresholdWeight = 6667;

    function _loadEigenlayerAddresses(string memory targetEnv) internal {
        string memory root = vm.projectRoot();
        string memory path = string.concat(
            root,
            "/script/avs/eigenlayer_addresses.json"
        );
        string memory json = vm.readFile(path);

        proxyAdmin = ProxyAdmin(
            json.readAddress(
                string(abi.encodePacked(".", targetEnv, ".proxyAdmin"))
            )
        );
        avsDirectory = IAVSDirectory(
            json.readAddress(
                string(abi.encodePacked(".", targetEnv, ".avsDirectory"))
            )
        );
        delegationManager = IDelegationManager(
            json.readAddress(
                string(abi.encodePacked(".", targetEnv, ".delegationManager"))
            )
        );
        // paymentCoordinator = IPaymentCoordinator(json.readAddress(string(abi.encodePacked(".", targetEnv, ".paymentCoordinator"))));
        paymentCoordinator = new TestPaymentCoordinator(); // temporary until Eigenlayer deploys the real one

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
            if (i < strategyCount - 1) {
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

    function run(string memory network, string memory metadataUri) external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        _loadEigenlayerAddresses(network);

        vm.startBroadcast(deployerPrivateKey);

        ECDSAStakeRegistry stakeRegistryImpl = new ECDSAStakeRegistry(
            delegationManager
        );
        TransparentUpgradeableProxy stakeRegistryProxy = new TransparentUpgradeableProxy(
                address(stakeRegistryImpl),
                address(proxyAdmin),
                ""
            );

        HyperlaneServiceManager strategyManagerImpl = new HyperlaneServiceManager(
                address(avsDirectory),
                address(stakeRegistryProxy),
                address(paymentCoordinator),
                address(delegationManager)
            );

        TransparentUpgradeableProxy hsmProxy = new TransparentUpgradeableProxy(
            address(strategyManagerImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(
                HyperlaneServiceManager.initialize.selector,
                address(deployerAddress)
            )
        );

        // Initialize the ECDSAStakeRegistry once we have the HyperlaneServiceManager proxy
        (bool success, ) = address(stakeRegistryProxy).call(
            abi.encodeWithSelector(
                ECDSAStakeRegistry.initialize.selector,
                address(hsmProxy),
                thresholdWeight,
                quorum
            )
        );

        HyperlaneServiceManager hsm = HyperlaneServiceManager(
            address(hsmProxy)
        );

        require(success, "Failed to initialize ECDSAStakeRegistry");
        require(
            ECDSAStakeRegistry(address(stakeRegistryProxy)).owner() ==
                address(deployerAddress),
            "Owner of ECDSAStakeRegistry is not the deployer"
        );
        require(
            HyperlaneServiceManager(address(hsmProxy)).owner() ==
                address(deployerAddress),
            "Owner of HyperlaneServiceManager is not the deployer"
        );

        hsm.updateAVSMetadataURI(metadataUri);

        console.log(
            "ECDSAStakeRegistry Implementation: ",
            address(stakeRegistryImpl)
        );
        console.log(
            "HyperlaneServiceManager Implementation: ",
            address(strategyManagerImpl)
        );
        console.log("StakeRegistry Proxy: ", address(stakeRegistryProxy));
        console.log("HyperlaneServiceManager Proxy: ", address(hsmProxy));

        vm.stopBroadcast();
    }
}
