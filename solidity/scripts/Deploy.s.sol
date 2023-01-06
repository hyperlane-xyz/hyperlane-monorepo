// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import "forge-std/Script.sol";
import "forge-std/StdJson.sol";

// Choose a domain ID
// Generate validator addresses
// Update networks.json
// Run deployment script
// Spin up validators
// Spin up relayer

import {Mailbox} from "../contracts/Mailbox.sol";
import {InterchainGasPaymaster} from "../contracts/InterchainGasPaymaster.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {MultisigIsm} from "../contracts/isms/MultisigIsm.sol";
import {BytesLib} from "../contracts/libs/BytesLib.sol";

contract Deploy is Script {
    using stdJson for string;
    using BytesLib for bytes;

    struct MultisigIsmConfig {
        uint8 threshold;
        address[] validators;
    }

    struct NetworkConfig {
        string name;
        uint32 domainId;
        MultisigIsmConfig ism;
    }

    function getNetworkConfig(string memory network)
        internal
        view
        returns (NetworkConfig memory)
    {
        string memory json = vm.readFile("networks.json");
        uint32 domainId = abi.decode(
            vm.parseJson(json, string.concat(network, ".id")),
            (uint32)
        );
        uint8 threshold = abi.decode(
            vm.parseJson(json, string.concat(network, ".threshold")),
            (uint8)
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
        return
            NetworkConfig(
                network,
                domainId,
                MultisigIsmConfig(threshold, validators)
            );
    }

    function getNetworkConfigs(string[] memory networks)
        internal
        view
        returns (NetworkConfig[] memory)
    {
        NetworkConfig[] memory configs = new NetworkConfig[](networks.length);
        for (uint256 i = 0; i < networks.length; i++) {
            string memory network = networks[i];
            configs[i] = getNetworkConfig(network);
        }
        return configs;
    }

    function deployIgp(address proxyAdmin)
        internal
        returns (InterchainGasPaymaster)
    {
        InterchainGasPaymaster igp = new InterchainGasPaymaster();
        bytes memory initData = abi.encodeCall(
            InterchainGasPaymaster.initialize,
            ()
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(igp),
            proxyAdmin,
            initData
        );
        return InterchainGasPaymaster(address(proxy));
    }

    function deployMailbox(
        address proxyAdmin,
        uint32 domainId,
        address defaultIsm
    ) internal returns (Mailbox) {
        Mailbox mailbox = new Mailbox(domainId);
        bytes memory initData = abi.encodeCall(
            Mailbox.initialize,
            (msg.sender, defaultIsm)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(mailbox),
            proxyAdmin,
            initData
        );
        return Mailbox(address(proxy));
    }

    function run() public {
        address owner = vm.envAddress("OWNER");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        string memory local = vm.envString("LOCAL");
        NetworkConfig memory config = getNetworkConfig(local);
        string[] memory remotes = vm.envString("REMOTES", ",");
        NetworkConfig[] memory configs = getNetworkConfigs(remotes);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy a default MultisigIsm and enroll validators for remote
        // networks.
        MultisigIsm ism = new MultisigIsm();
        uint32[] memory remoteDomainIds = new uint32[](configs.length);
        uint8[] memory remoteThresholds = new uint8[](configs.length);
        address[][] memory remoteValidators = new address[][](configs.length);
        for (uint256 i = 0; i < configs.length; i++) {
            remoteDomainIds[i] = configs[i].domainId;
            remoteThresholds[i] = configs[i].ism.threshold;
            remoteValidators[i] = configs[i].ism.validators;
        }
        ism.enrollValidators(remoteDomainIds, remoteValidators);
        ism.setThresholds(remoteDomainIds, remoteThresholds);

        ProxyAdmin proxyAdmin = new ProxyAdmin();
        InterchainGasPaymaster igp = deployIgp(address(proxyAdmin));
        Mailbox mailbox = deployMailbox(
            address(proxyAdmin),
            config.domainId,
            address(ism)
        );

        // Transfer ownership of ownable contracts.
        proxyAdmin.transferOwnership(owner);
        igp.transferOwnership(owner);
        mailbox.transferOwnership(owner);
        ism.transferOwnership(owner);
    }
}
