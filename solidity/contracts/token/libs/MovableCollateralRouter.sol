// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "contracts/client/Router.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";

import {EnumerableMapExtended, EnumerableMap} from "contracts/libs/EnumerableMapExtended.sol";

import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract MovableCollateralRouter is Router {
    using SafeERC20 for IERC20;
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    /// @notice Mapping of domains to allowed recipients => router. For a given domain we have one router we send/receive messages from.
    /// @dev mapping(uint32 destinationDomain => bytes32 recipient)
    EnumerableMapExtended.UintToBytes32Map internal _allowedRecipients;

    /// @notice Returns all domains that have a recipient.
    function allDomains() external view returns (uint32[] memory) {
        return _allowedRecipients.uint32Keys();
    }

    /// @notice Returns recipient for a given domain.
    function allowedRecipients(uint32 domain) external view returns (bytes32) {
        (, bytes32 recipient) = _allowedRecipients.tryGet(domain);
        return recipient;
    }

    mapping(uint32 destinationDomain => mapping(ValueTransferBridge bridge => bool isValidBridge))
        public allowedBridges;

    /// @notice Mapping of address to true if the address is a rebalancer.
    /// @dev mapping(address user => bool isRebalancer)
    EnumerableMap.AddressToUintMap internal _allowedRebalancers;

    /// @notice All rebalancers.
    function allRebalancers() external view returns (address[] memory) {
        return _allowedRebalancers.keys();
    }

    /// @notice Returns true if a given address is a rebalancer.
    function allowedRebalancers(
        address rebalancer
    ) external view returns (bool) {
        return _allowedRebalancers.contains(rebalancer);
    }

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    error BadBridge(address rebalancer, ValueTransferBridge bridge);

    modifier onlyRebalancer() {
        require(
            _allowedRebalancers.contains(_msgSender()),
            "MCR: Only Rebalancer"
        );
        _;
    }

    function addRebalancer(address rebalancer) external onlyOwner {
        _allowedRebalancers.set(rebalancer, 1);
    }

    function removeRebalancer(address rebalancer) external onlyOwner {
        _allowedRebalancers.remove(rebalancer);
    }

    function addRebalancers(address[] calldata rebalancers) external onlyOwner {
        for (uint256 i = 0; i < rebalancers.length; i++) {
            _allowedRebalancers.set(rebalancers[i], 1);
        }
    }

    function removeRebalancers(
        address[] calldata rebalancers
    ) external onlyOwner {
        for (uint256 i = 0; i < rebalancers.length; i++) {
            _allowedRebalancers.remove(rebalancers[i]);
        }
    }

    function rebalance(
        uint32 domain,
        uint256 amount,
        ValueTransferBridge bridge
    ) external payable onlyRebalancer {
        address rebalancer = _msgSender();

        (, bytes32 recipient) = _allowedRecipients.tryGet(domain);
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
        _allowedRecipients.set(domain, recipient);
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
