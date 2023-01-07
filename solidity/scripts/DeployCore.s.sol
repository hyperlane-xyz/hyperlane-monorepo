// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import "forge-std/Script.sol";
import "forge-std/StdJson.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {InterchainGasPaymaster} from "../contracts/InterchainGasPaymaster.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {MultisigIsm} from "../contracts/isms/MultisigIsm.sol";
import {DeployLib} from "./lib/DeployLib.sol";

contract DeployCore is Script {
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
        address deployer,
        address proxyAdmin,
        uint32 domainId,
        address defaultIsm
    ) internal returns (Mailbox) {
        Mailbox mailbox = new Mailbox(domainId);
        bytes memory initData = abi.encodeCall(
            Mailbox.initialize,
            (deployer, defaultIsm)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(mailbox),
            proxyAdmin,
            initData
        );
        return Mailbox(address(proxy));
    }

    function run() public {
        // Read all the config we need first so that we ensure valid
        // config before sending any transactions.
        address owner = vm.envAddress("OWNER");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        string memory local = vm.envString("LOCAL");
        uint32 localDomain = DeployLib.getDomainId(vm, local);
        string[] memory remotes = vm.envString("REMOTES", ",");
        DeployLib.MultisigIsmConfig[] memory configs = DeployLib
            .getMultisigIsmConfigs(vm, remotes);

        vm.startBroadcast(deployerPrivateKey);

        MultisigIsm ism = DeployLib.deployMultisigIsm(configs);
        ProxyAdmin proxyAdmin = new ProxyAdmin();
        InterchainGasPaymaster igp = deployIgp(address(proxyAdmin));
        address deployer = vm.addr(deployerPrivateKey);
        Mailbox mailbox = deployMailbox(
            deployer,
            address(proxyAdmin),
            localDomain,
            address(ism)
        );

        // Transfer ownership of ownable contracts.
        proxyAdmin.transferOwnership(owner);
        igp.transferOwnership(owner);
        mailbox.transferOwnership(owner);
        ism.transferOwnership(owner);
    }
}
