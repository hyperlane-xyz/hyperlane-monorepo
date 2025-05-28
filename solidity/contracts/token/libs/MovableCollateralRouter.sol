// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "contracts/client/Router.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract MovableCollateralRouter is Router {
    using SafeERC20 for IERC20;

    mapping(uint32 destinationDomain => bytes32 recipient)
        public allowedDestinations;

    mapping(uint32 destinationDomain => mapping(ValueTransferBridge bridge => bool isValidBridge))
        public allowedBridges;

    mapping(address user => bool isRebalancer) public allowedRebalancers;

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    error BadBridge(address rebalancer, ValueTransferBridge bridge);

    function addRebalancer(address rebalancer) external onlyOwner {
        allowedRebalancers[rebalancer] = true;
    }

    modifier onlyRebalancer() {
        require(allowedRebalancers[_msgSender()], "MCR: Only Rebalancer");
        _;
    }

    function rebalance(
        uint32 domain,
        uint256 amount,
        ValueTransferBridge bridge
    ) external payable onlyRebalancer {
        address rebalancer = _msgSender();

        bytes32 recipient = allowedDestinations[domain];
        if (recipient == bytes32(0)) {
            recipient = _mustHaveRemoteRouter(domain);
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

    function addRecipient(uint32 domain, bytes32 recipient) external onlyOwner {
        allowedDestinations[domain] = recipient;
    }

    function addBridge(
        ValueTransferBridge bridge,
        uint32 destinationDomain
    ) external onlyOwner {
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
    ) external onlyOwner {
        token.safeApprove(address(bridge), type(uint256).max);
    }
}
