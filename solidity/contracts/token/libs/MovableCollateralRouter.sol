// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract MovableCollateralRouter is AccessControlUpgradeable {
    using SafeERC20 for IERC20;

    function _MovableCollateralRouter_initialize(address admin) internal {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    bytes32 public constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");

    mapping(uint32 destinationDomain => bytes32 recipient)
        public allowedDestinations;
    mapping(uint32 destinationDomain => mapping(ValueTransferBridge bridge => bool isValidBridge))
        public allowedBridges;

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    error BadDestination(address rebalancer, uint32 domain);
    error BadBridge(address rebalancer, ValueTransferBridge bridge);

    function rebalance(
        uint32 domain,
        uint256 amount,
        ValueTransferBridge bridge
    ) external payable onlyRole(REBALANCER_ROLE) {
        address rebalancer = _msgSender();
        bytes32 recipient = allowedDestinations[domain];
        if (recipient == bytes32(0)) {
            revert BadDestination({rebalancer: rebalancer, domain: domain});
        }

        if (!(allowedBridges[domain][bridge])) {
            revert BadBridge({rebalancer: rebalancer, bridge: bridge});
        }

        _rebalance(domain, recipient, amount, bridge);
        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: rebalancer
        });
    }

    function _rebalance(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) internal virtual {
        bridge.transferRemote{value: msg.value}({
            destinationDomain: domain,
            recipient: recipient,
            amountOut: amount
        });
    }

    function addRecipient(
        uint32 domain,
        bytes32 recipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedDestinations[domain] = recipient;
    }

    function addBridge(
        ValueTransferBridge bridge,
        uint32 destinationDomain
    ) external onlyRole((DEFAULT_ADMIN_ROLE)) {
        allowedBridges[destinationDomain][bridge] = true;
    }

    /**
     * @notice Approves the token for the bridge.
     * @param token The token to approve.
     * @param bridge The bridge to approve the token for.
     * @dev We need this to support bridges that charge fees in ERC20 tokens.
     */
    function approveTokenForBridge(
        IERC20 token,
        ValueTransferBridge bridge
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        token.safeApprove(address(bridge), type(uint256).max);
    }
}
