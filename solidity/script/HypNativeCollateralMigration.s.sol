// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";

import {HypNative} from "../contracts/token/HypNative.sol";
import {TrustedRelayerIsm} from "../contracts/isms/TrustedRelayerIsm.sol";
import {Router} from "../contracts/client/Router.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

/**
 * @title HypNativeCollateralMigration
 * @notice Migrates native token collateral from old HypNative to a pre-deployed new HypNative
 * @dev This script:
 *   1. Deploys TrustedRelayerIsm to allow spoofed message processing
 *   2. Migrates collateral via spoofed Hyperlane message
 *   3. Unenrolls the remote router from the old contract to prevent further deposits
 *
 * The new HypNative must be deployed and configured externally before running this script.
 *
 * Safety: Re-running will fail because:
 *   - `require(balance > 0)` fails after migration (old contract has 0 balance)
 *   - `require(!mailbox.delivered(messageId))` fails if message was already processed
 *   - CREATE2 reverts if TrustedRelayerIsm already exists at predicted address
 *
 * Environment variables:
 *   OLD_ROUTER     - Address of the old HypNative contract to migrate from (required)
 *   NEW_ROUTER     - Address of the new HypNative contract to migrate to (required)
 *   REMOTE_DOMAIN  - Domain ID of the remote chain (required)
 *
 * Usage (via pipeline script):
 *   OLD_ROUTER=0x... NEW_ROUTER=0x... REMOTE_DOMAIN=... ./script/migration-pipeline.sh
 *
 * This generates a Safe Transaction Builder JSON file that can be imported into the Safe UI.
 */
contract HypNativeCollateralMigration is Script {
    using TypeCasts for address;

    // Message constants
    uint8 constant MAILBOX_VERSION = 3;

    struct Config {
        address oldRouter;
        address newRouter;
        uint32 remoteDomain;
        uint32 localDomain;
        address owner;
        bytes32 remoteRouter;
        IMailbox mailbox;
        bytes32 salt;
    }

    function run() external {
        Config memory cfg = _loadConfig();

        vm.startBroadcast();

        TrustedRelayerIsm ism = _deployIsm(cfg);
        uint256 balance = _migrate(cfg, ism);

        vm.stopBroadcast();

        _logResults(cfg, address(ism), balance);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.oldRouter = vm.envAddress("OLD_ROUTER");
        cfg.newRouter = vm.envAddress("NEW_ROUTER");
        cfg.remoteDomain = uint32(vm.envUint("REMOTE_DOMAIN"));

        // Derive deterministic salt from migration parameters
        cfg.salt = keccak256(abi.encode(cfg.oldRouter, cfg.remoteDomain));

        Router oldRouter = Router(cfg.oldRouter);
        cfg.mailbox = oldRouter.mailbox();
        cfg.localDomain = cfg.mailbox.localDomain();
        cfg.owner = oldRouter.owner();
        cfg.remoteRouter = oldRouter.routers(cfg.remoteDomain);

        require(cfg.remoteRouter != bytes32(0), "Remote router not enrolled");
    }

    function _deployIsm(
        Config memory cfg
    ) internal returns (TrustedRelayerIsm ism) {
        ism = TrustedRelayerIsm(
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
        TrustedRelayerIsm ism
    ) internal returns (uint256 balance) {
        Router oldRouter = Router(cfg.oldRouter);

        // Store previous ISM to restore after migration
        address prevIsm = address(oldRouter.interchainSecurityModule());

        // Set permissive ISM on old contract
        oldRouter.setInterchainSecurityModule(address(ism));

        // Build and process spoofed message
        balance = cfg.oldRouter.balance;
        require(balance > 0, "No balance to migrate");

        uint256 prevNewRouterBalance = cfg.newRouter.balance;

        bytes memory message = _buildMessage(cfg, cfg.newRouter, balance);
        require(
            !cfg.mailbox.delivered(keccak256(message)),
            "Message already delivered"
        );

        // Process message - transfers native tokens from old to new
        cfg.mailbox.process("", message);

        // Verify migration succeeded with exact balance check
        require(
            cfg.newRouter.balance == prevNewRouterBalance + balance,
            "Migration failed"
        );

        // Cleanup: restore previous ISM
        oldRouter.setInterchainSecurityModule(prevIsm);

        // Unenroll remote router to prevent deposits to drained contract
        oldRouter.unenrollRemoteRouter(cfg.remoteDomain);
    }

    function _logResults(
        Config memory cfg,
        address ism,
        uint256 balance
    ) internal view {
        console.log("=== Migration Complete ===");
        console.log("Old HypNative:", cfg.oldRouter);
        console.log("New HypNative:", cfg.newRouter);
        console.log("TrustedRelayerIsm:", ism);
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
