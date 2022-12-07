// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.0;

import "forge-std/console.sol";
import "forge-std/Script.sol";
import "forge-std/StdJson.sol";

import {ICREATE3Factory} from "../lib/create3-factory/src/ICREATE3Factory.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {MultisigIsm} from "../contracts/isms/MultisigIsm.sol";
import {BytesLib} from "../contracts/libs/BytesLib.sol";

contract Deploy is Script {
    using stdJson for string;
    using BytesLib for bytes;

    function getCreate3Factory(string memory network)
        internal
        view
        returns (ICREATE3Factory)
    {
        string memory file = string.concat(
            "lib/create3-factory/deployments/",
            network,
            ".json"
        );
        string memory json = vm.readFile(file);
        return
            ICREATE3Factory(
                abi.decode(vm.parseJson(json, "CREATE3Factory"), (address))
            );
    }

    function getDomainId(string memory network) internal view returns (uint32) {
        string memory json = vm.readFile("chains.json");
        return
            abi.decode(
                vm.parseJson(json, string.concat(network, ".id")),
                (uint32)
            );
    }

    struct MultisigIsmConfig {
        uint256 threshold;
        address[] validators;
    }

    function getMultisigIsmConfig(string memory network)
        internal
        view
        returns (MultisigIsmConfig memory)
    {
        string memory json = vm.readFile("validators.json");
        uint256 threshold = abi.decode(
            vm.parseJson(json, string.concat(network, ".threshold")),
            (uint256)
        );
        bytes memory validatorBytes = json.parseRaw(
            string.concat(network, ".validators[*].address")
        );
        uint256 numValidators = validatorBytes.length / 32;
        address[] memory validators = new address[](numValidators);
        for (uint256 i = 0; i < validators.length; i++) {
            validators[i] = abi.decode(
                validatorBytes.slice(i * 32, 32),
                (address)
            );
        }
        return MultisigIsmConfig(threshold, validators);
    }

    struct NetworkConfig {
        uint32 domainId;
        ICREATE3Factory factory;
        MultisigIsmConfig ism;
    }

    function getConfig(string[] memory networks)
        internal
        view
        returns (NetworkConfig[] memory)
    {
        NetworkConfig[] memory configs = new NetworkConfig[](networks.length);
        for (uint256 i = 0; i < networks.length; i++) {
            string memory network = networks[i];
            configs[i] = NetworkConfig({
                domainId: getDomainId(network),
                ism: getMultisigIsmConfig(network),
                factory: getCreate3Factory(network)
            });
        }
        return configs;
    }

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // string memory salt = vm.envString("SALT");
        uint256 nonce = 0;

        string[] memory networks = vm.envString("NETWORKS", ",");
        NetworkConfig[] memory configs = getConfig(networks);

        // deploy each network
        for (uint256 i = 0; i < configs.length; i++) {
            NetworkConfig memory config = configs[i];
            // TODO: switch network forks if not local

            MultisigIsm ism = MultisigIsm(
                config.factory.deploy(
                    bytes32(nonce),
                    abi.encodePacked(type(MultisigIsm).creationCode)
                )
            );
            for (uint256 n = 0; n < networks.length; n++) {
                if (n != i) {
                    NetworkConfig memory remoteConfig = configs[n];
                    for (
                        uint256 v = 0;
                        v < remoteConfig.ism.validators.length;
                        v++
                    ) {
                        ism.enrollValidator(
                            remoteConfig.domainId,
                            remoteConfig.ism.validators[v]
                        );
                    }
                    ism.setThreshold(
                        remoteConfig.domainId,
                        remoteConfig.ism.threshold
                    );
                }
            }

            // deploy Mailbox
            Mailbox mailbox = Mailbox(
                config.factory.deploy(
                    bytes32(nonce + 1),
                    abi.encodePacked(
                        type(Mailbox).creationCode,
                        abi.encode(config.domainId)
                    )
                )
            );
            mailbox.initialize(address(ism));
        }
    }
}
