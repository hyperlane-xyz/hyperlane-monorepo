// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

import {HypNative} from "../contracts/token/HypNative.sol";
import {TrustedRelayerIsm} from "../contracts/isms/TrustedRelayerIsm.sol";
import {GasRouter} from "../contracts/client/GasRouter.sol";
import {Router} from "../contracts/client/Router.sol";
import {MailboxClient} from "../contracts/client/MailboxClient.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

/**
 * @title HypNativeCollateralMigration
 * @notice Atomically migrates native token collateral from old non-proxied HypNative to new proxied HypNative
 * @dev This script:
 *   1. Uses pre-deployed ProxyAdmin (must be owned by the Safe)
 *   2. Deploys new proxied HypNative infrastructure (CREATE2 for determinism)
 *   3. Deploys TrustedRelayerIsm to allow spoofed message processing
 *   4. Migrates collateral via spoofed Hyperlane message
 *   5. Configures new contract with same router enrollment and gas settings
 *   6. Transfers ownership of new proxy to the Safe
 *
 * Deployment strategy:
 *   - ProxyAdmin: Pre-deployed externally (required for deterministic batch)
 *   - HypNative impl, Proxy, TrustedRelayerIsm: CREATE2 with deterministic salt
 *
 * Why pre-deployed ProxyAdmin?
 *   CREATE2 via deterministic deployer makes the factory the msg.sender, so OZ ProxyAdmin
 *   would be owned by factory instead of Safe. Pre-deploying separately ensures Safe ownership.
 *
 * Safety: Re-running will fail because:
 *   - `require(balance > 0)` fails after migration (old contract has 0 balance)
 *   - `require(!mailbox.delivered(messageId))` fails if message was already processed
 *   - CREATE2 reverts if contracts already exist at predicted addresses
 *
 * Environment variables:
 *   OLD_ROUTER     - Address of the old HypNative contract to migrate from (required)
 *   REMOTE_DOMAIN  - Domain ID of the remote chain (required)
 *   PROXY_ADMIN    - Address of pre-deployed ProxyAdmin owned by Safe (required)
 *
 * Usage (via pipeline script):
 *   PROXY_ADMIN=0x... ./script/migration-pipeline.sh
 *
 * This generates a Safe Transaction Builder JSON file that can be imported into the Safe UI.
 */
contract HypNativeCollateralMigration is Script {
    using TypeCasts for address;

    // Message constants
    uint8 constant MAILBOX_VERSION = 3;

    struct Config {
        address oldRouter;
        uint32 remoteDomain;
        uint32 localDomain;
        address owner;
        bytes32 remoteRouter;
        uint256 destinationGas;
        IMailbox mailbox;
        bytes32 salt;
        ProxyAdmin proxyAdmin;
    }

    struct Deployment {
        HypNative implementation;
        HypNative proxy;
        ProxyAdmin proxyAdmin;
        TrustedRelayerIsm ism;
    }

    function run() external {
        Config memory cfg = _loadConfig();

        vm.startBroadcast();

        Deployment memory dep = _deploy(cfg);
        uint256 balance = _migrate(cfg, dep);
        _configure(cfg, dep);

        vm.stopBroadcast();

        _logResults(cfg, dep, balance);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.oldRouter = vm.envAddress("OLD_ROUTER");
        cfg.remoteDomain = uint32(vm.envUint("REMOTE_DOMAIN"));
        cfg.proxyAdmin = ProxyAdmin(vm.envAddress("PROXY_ADMIN"));

        // Derive deterministic salt from migration parameters
        cfg.salt = keccak256(abi.encode(cfg.oldRouter, cfg.remoteDomain));

        Router oldRouter = Router(cfg.oldRouter);
        cfg.mailbox = oldRouter.mailbox();
        cfg.localDomain = cfg.mailbox.localDomain();
        cfg.owner = oldRouter.owner();
        cfg.remoteRouter = oldRouter.routers(cfg.remoteDomain);
        cfg.destinationGas = GasRouter(cfg.oldRouter).destinationGas(
            cfg.remoteDomain
        );

        require(cfg.remoteRouter != bytes32(0), "Remote router not enrolled");

        // Verify ProxyAdmin bytecode and ownership
        bytes memory expectedBytecode = type(ProxyAdmin).runtimeCode;
        bytes memory deployedBytecode = address(cfg.proxyAdmin).code;
        require(
            keccak256(deployedBytecode) == keccak256(expectedBytecode),
            "ProxyAdmin bytecode mismatch"
        );
        require(
            cfg.proxyAdmin.owner() == cfg.owner,
            "ProxyAdmin not owned by Safe"
        );
    }

    function _deploy(
        Config memory cfg
    ) internal returns (Deployment memory dep) {
        // Use pre-deployed ProxyAdmin (verified in _loadConfig)
        dep.proxyAdmin = cfg.proxyAdmin;

        // Deploy implementation via CREATE2 factory
        dep.implementation = HypNative(
            payable(
                _create2(
                    cfg.salt,
                    abi.encodePacked(
                        type(HypNative).creationCode,
                        abi.encode(1, address(cfg.mailbox))
                    )
                )
            )
        );

        // Deploy proxy via CREATE2 factory
        bytes memory proxyInitData = abi.encodeCall(
            HypNative.initialize,
            (address(0), address(0), msg.sender) // hook=0, ism=0 (use mailbox defaults)
        );
        dep.proxy = HypNative(
            payable(
                _create2(
                    cfg.salt,
                    abi.encodePacked(
                        type(TransparentUpgradeableProxy).creationCode,
                        abi.encode(
                            address(dep.implementation),
                            address(dep.proxyAdmin),
                            proxyInitData
                        )
                    )
                )
            )
        );

        // Deploy TrustedRelayerIsm via CREATE2 factory
        dep.ism = TrustedRelayerIsm(
            _create2(
                cfg.salt,
                abi.encodePacked(
                    type(TrustedRelayerIsm).creationCode,
                    abi.encode(address(cfg.mailbox), msg.sender)
                )
            )
        );
    }

    function _create2(
        bytes32 salt,
        bytes memory initCode
    ) internal returns (address) {
        (bool success, bytes memory result) = CREATE2_FACTORY.call(
            abi.encodePacked(salt, initCode)
        );
        require(success, "CREATE2 failed");
        return address(bytes20(result));
    }

    function _migrate(
        Config memory cfg,
        Deployment memory dep
    ) internal returns (uint256 balance) {
        Router oldRouter = Router(cfg.oldRouter);

        // Set permissive ISM on old contract
        oldRouter.setInterchainSecurityModule(address(dep.ism));

        // Build and process spoofed message
        balance = cfg.oldRouter.balance;
        require(balance > 0, "No balance to migrate");

        bytes memory message = _buildMessage(cfg, address(dep.proxy), balance);
        require(
            !cfg.mailbox.delivered(keccak256(message)),
            "Message already delivered"
        );

        // Process message - transfers native tokens from old to new
        cfg.mailbox.process("", message);

        // Verify migration succeeded
        require(address(dep.proxy).balance >= balance, "Migration failed");

        // Cleanup: restore ISM to default
        oldRouter.setInterchainSecurityModule(address(0));
    }

    function _configure(Config memory cfg, Deployment memory dep) internal {
        dep.proxy.enrollRemoteRouter(cfg.remoteDomain, cfg.remoteRouter);
        dep.proxy.setDestinationGas(cfg.remoteDomain, cfg.destinationGas);
        dep.proxy.transferOwnership(cfg.owner);
    }

    function _logResults(
        Config memory cfg,
        Deployment memory dep,
        uint256 balance
    ) internal view {
        console.log("=== Migration Complete ===");
        console.log("Salt:", vm.toString(cfg.salt));
        console.log("New HypNative (proxy):", address(dep.proxy));
        console.log("New HypNative (impl):", address(dep.implementation));
        console.log("ProxyAdmin:", address(dep.proxyAdmin));
        console.log("ProxyAdmin owner:", dep.proxyAdmin.owner());
        console.log("TrustedRelayerIsm:", address(dep.ism));
        console.log("Migrated (wei):");
        console.log(balance);
    }

    function _buildMessage(
        Config memory cfg,
        address _transferTo,
        uint256 _amount
    ) internal pure returns (bytes memory) {
        // TokenMessage: recipient (bytes32) + amount (uint256)
        bytes memory body = abi.encodePacked(
            _transferTo.addressToBytes32(),
            _amount
        );

        // Hyperlane message format
        return
            abi.encodePacked(
                MAILBOX_VERSION, // version (uint8)
                uint32(type(uint32).max), // nonce (max to avoid collision)
                cfg.remoteDomain, // origin (uint32)
                cfg.remoteRouter, // sender (bytes32)
                cfg.localDomain, // destination (uint32)
                cfg.oldRouter.addressToBytes32(), // recipient (bytes32)
                body // message body
            );
    }
}
