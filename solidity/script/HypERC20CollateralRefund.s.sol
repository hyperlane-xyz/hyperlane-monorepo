// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HypERC20Collateral} from "../contracts/token/HypERC20Collateral.sol";
import {TrustedRelayerIsm} from "../contracts/isms/TrustedRelayerIsm.sol";
import {Router} from "../contracts/client/Router.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

/**
 * @title HypERC20CollateralRefund
 * @notice Refunds stuck ERC20 tokens from an old HypERC20Collateral router back to original depositors
 * @dev Uses the TrustedRelayerIsm spoofed-message trick (same as HypNativeCollateralMigration)
 *   1. Deploy TrustedRelayerIsm that trusts the Safe/sender
 *   2. Set TrustedRelayerIsm on old router
 *   3. For each depositor, craft a spoofed Hyperlane message and call mailbox.process()
 *   4. Restore previous ISM
 *
 * Environment variables:
 *   OLD_ROUTER     - Address of the old HypERC20Collateral contract
 *   REMOTE_DOMAIN  - Any enrolled remote domain to spoof messages from
 *
 * Requires REFUND_RECIPIENTS and REFUND_AMOUNTS env vars (set by refund-pipeline.sh)
 */
contract HypERC20CollateralRefund is Script {
    using TypeCasts for address;

    uint8 constant MAILBOX_VERSION = 3;

    // Fields in alphabetical order for vm.parseJson compatibility
    struct Refund {
        uint256 amount;
        address recipient;
    }

    struct Config {
        address oldRouter;
        uint32 remoteDomain;
        uint32 localDomain;
        address owner;
        bytes32 remoteRouter;
        IMailbox mailbox;
        IERC20 wrappedToken;
        bytes32 salt;
    }

    function _refunds() internal view returns (Refund[] memory) {
        address[] memory recipients = vm.envAddress("REFUND_RECIPIENTS", ",");
        uint256[] memory amounts = vm.envUint("REFUND_AMOUNTS", ",");
        require(recipients.length == amounts.length, "Refund length mismatch");

        Refund[] memory r = new Refund[](recipients.length);
        for (uint256 i = 0; i < recipients.length; i++) {
            r[i].recipient = recipients[i];
            r[i].amount = amounts[i];
        }
        return r;
    }

    function run() external {
        Config memory cfg = _loadConfig();
        Refund[] memory refunds = _refunds();

        vm.startBroadcast();

        TrustedRelayerIsm ism = _deployIsm(cfg);
        _refundAll(cfg, ism, refunds);

        vm.stopBroadcast();

        _logResults(cfg, address(ism), refunds);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.oldRouter = vm.envAddress("OLD_ROUTER");
        cfg.remoteDomain = uint32(vm.envUint("REMOTE_DOMAIN"));

        cfg.salt = keccak256(
            abi.encode("refund", cfg.oldRouter, cfg.remoteDomain)
        );

        Router oldRouter = Router(cfg.oldRouter);
        cfg.mailbox = oldRouter.mailbox();
        cfg.localDomain = cfg.mailbox.localDomain();
        cfg.owner = oldRouter.owner();
        cfg.remoteRouter = oldRouter.routers(cfg.remoteDomain);
        cfg.wrappedToken = HypERC20Collateral(cfg.oldRouter).wrappedToken();

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

    function _refundAll(
        Config memory cfg,
        TrustedRelayerIsm ism,
        Refund[] memory refunds
    ) internal {
        Router oldRouter = Router(cfg.oldRouter);
        address prevIsm = address(oldRouter.interchainSecurityModule());

        // Set permissive ISM
        oldRouter.setInterchainSecurityModule(address(ism));

        uint256 totalRefunded;
        for (uint256 i = 0; i < refunds.length; i++) {
            uint256 prevBalance = cfg.wrappedToken.balanceOf(
                refunds[i].recipient
            );

            bytes memory message = _buildMessage(
                cfg,
                refunds[i].recipient,
                refunds[i].amount,
                uint32(type(uint32).max - i) // unique nonce per message
            );
            require(
                !cfg.mailbox.delivered(keccak256(message)),
                "Message already delivered"
            );

            cfg.mailbox.process("", message);

            require(
                cfg.wrappedToken.balanceOf(refunds[i].recipient) ==
                    prevBalance + refunds[i].amount,
                "Refund failed"
            );
            totalRefunded += refunds[i].amount;
        }

        // Verify router balance decreased by total refunded
        console.log("Total refunded:", totalRefunded);

        // Restore previous ISM
        oldRouter.setInterchainSecurityModule(prevIsm);
    }

    function _logResults(
        Config memory cfg,
        address ism,
        Refund[] memory refunds
    ) internal pure {
        console.log("=== Refund Complete ===");
        console.log("Old Router:", cfg.oldRouter);
        console.log("TrustedRelayerIsm:", ism);
        for (uint256 i = 0; i < refunds.length; i++) {
            console.log("Refunded:", refunds[i].recipient, refunds[i].amount);
        }
    }

    function _buildMessage(
        Config memory cfg,
        address _recipient,
        uint256 _amount,
        uint32 _nonce
    ) internal pure returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            _recipient.addressToBytes32(),
            _amount
        );
        return
            abi.encodePacked(
                MAILBOX_VERSION,
                _nonce,
                cfg.remoteDomain,
                cfg.remoteRouter,
                cfg.localDomain,
                cfg.oldRouter.addressToBytes32(),
                body
            );
    }
}
