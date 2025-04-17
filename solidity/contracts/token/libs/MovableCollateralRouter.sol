// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

abstract contract MovableCollateralRouter is AccessControl {
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
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

    function moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) external onlyRole(REBALANCER_ROLE) {
        address rebalancer = _msgSender();
        if (allowedDestinations[domain] != recipient) {
            revert BadDestination({rebalancer: rebalancer, domain: domain});
        }

        if (!(allowedBridges[domain][bridge])) {
            revert BadBridge({rebalancer: rebalancer, bridge: bridge});
        }

        _moveCollateral(domain, recipient, amount, bridge);
        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: rebalancer
        });
    }

    function _moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) internal virtual {
        bridge.transferRemote({
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
}
