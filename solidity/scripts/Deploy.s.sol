// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import "forge-std/Script.sol";
import "forge-std/StdJson.sol";

// import {ICREATE3Factory} from "../lib/create3-factory/src/ICREATE3Factory.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {InterchainGasPaymaster} from "../contracts/InterchainGasPaymaster.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";
import {MultisigIsm} from "../contracts/isms/MultisigIsm.sol";
import {BytesLib} from "../contracts/libs/BytesLib.sol";

contract Deploy is Script {
    using stdJson for string;
    using BytesLib for bytes;

    /*
    function getCreate2Factory(string memory network)
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
    */

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

    function deployIgp(address proxyAdmin) returns (address) {
        InterchainGasPaymaster igp = new InterchainGasPaymaster();
        bytes memory initData = abi.encodeCall(
            InterchainGasPaymaster.initialize
        );
        address proxy = proxyContract(igp, proxyAdmin, initData);
        return proxy;
    }

    function deployMailbox(
        address proxyAdmin,
        uint32 domainId,
        address owner,
        address defaultIsm
    ) returns (address) {
        Mailbox mailbox = new Mailbox(domainId);
        bytes memory initData = abi.encodeCall(
            Mailbox.initialize,
            owner,
            defaultIsm
        );
        address proxy = proxyContract(mailbox, proxyAdmin, initData);
        return proxy;
    }

    // TODO: Create2 support
    function proxyContract(
        address implementation,
        address proxyAdmin,
        bytes memory initData
    ) internal returns (address) {
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            implementation,
            proxyAdmin,
            initData
        );
        return address(proxy);
    }

    function run() public {
        address owner = vm.envUint("OWNER");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        string memory local = vm.envString("LOCAL", ",");
        string[] memory networks = vm.envString("REMOTES", ",");
        networks.push(local);
        NetworkConfig[] memory configs = getNetworkConfigs(networks);

        // Deploy a default MultisigIsm and enroll validators for remote
        // networks.
        MultisigIsm ism = new MultisigIsm();
        uint32[] memory remoteDomainIds = new uint32[](configs.length - 1);
        uint8[] memory remoteThresholds = new uint8[](configs.length - 1);
        address[][] memory remoteValidators = new address[][](
            configs.length - 1
        );
        // The local network is the last entry in configs, we skip it as we
        // do not need to enroll local validators.
        for (uint256 i = 0; i < configs.length - 1; i++) {
            NetworkConfig memory config = configs[i];
            remoteDomainIds[i] = config.domainId;
            remoteThresholds[i] = config.ism.threshold;
            remoteValidators[i] = config.ism.validators;
        }
        ism.setThresholds(remoteDomainIds, remoteThresholds);
        ism.enrollValidators(remoteDomainIds, remoteValidators);

        ProxyAdmin proxyAdmin = new ProxyAdmin();
        InterchainGasPaymaster igp = deployIgp(proxyAdmin);
        Mailbox mailbox = deployMailbox(
            address(proxyAdmin),
            configs[-1].domainId,
            owner,
            address(ism)
        );

        // Transfer ownership of ownable contracts.
        proxyAdmin.transferOwnership(owner);
        igp.transferOwnership(owner);
        mailbox.transferOwnership(owner);
        ism.transferOwnership(owner);
    }
}
