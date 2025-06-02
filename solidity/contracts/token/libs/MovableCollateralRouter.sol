// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "contracts/client/Router.sol";
import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {ValueTransferBridge} from "./ValueTransferBridge.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract MovableCollateralRouter is FungibleTokenRouter {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    mapping(uint32 routerDomain => bytes32 recipient) public allowedRecipient;
    mapping(uint32 routerDomain => EnumerableSet.AddressSet)
        internal _allowedBridges;

    /// @notice Mapping of address to true if the address is a rebalancer.
    EnumerableSet.AddressSet internal _allowedRebalancers;

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    modifier onlyRebalancer() {
        require(
            _allowedRebalancers.contains(_msgSender()),
            "MCR: Only Rebalancer"
        );
        _;
    }

    modifier onlyAllowedBridge(uint32 domain, ValueTransferBridge bridge) {
        EnumerableSet.AddressSet storage bridges = _allowedBridges[domain];
        require(bridges.contains(address(bridge)), "MCR: Not allowed bridge");
        _;
    }

    function allowedRebalancers() external view returns (address[] memory) {
        return _allowedRebalancers.values();
    }

    function allowedBridges(
        uint32 domain
    ) external view returns (address[] memory) {
        return _allowedBridges[domain].values();
    }

    function setRecipient(uint32 domain, bytes32 recipient) external onlyOwner {
        _mustHaveRemoteRouter(domain);
        allowedRecipient[domain] = recipient;
    }

    function removeRecipient(uint32 domain) external onlyOwner {
        delete allowedRecipient[domain];
    }

    function addBridge(
        uint32 domain,
        ValueTransferBridge bridge
    ) external onlyOwner {
        _mustHaveRemoteRouter(domain);
        _allowedBridges[domain].add(address(bridge));
    }

    function removeBridge(
        uint32 domain,
        ValueTransferBridge bridge
    ) external onlyOwner {
        _allowedBridges[domain].remove(address(bridge));
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

    function addRebalancer(address rebalancer) external onlyOwner {
        _allowedRebalancers.add(rebalancer);
    }

    function removeRebalancer(address rebalancer) external onlyOwner {
        _allowedRebalancers.remove(rebalancer);
    }

    function rebalance(
        uint32 domain,
        uint256 amount,
        ValueTransferBridge bridge
    ) external payable onlyRebalancer onlyAllowedBridge(domain, bridge) {
        address rebalancer = _msgSender();

        bytes32 recipient = allowedRecipient[domain];
        if (recipient == bytes32(0)) {
            recipient = _mustHaveRemoteRouter(domain);
        }

        _rebalance(domain, recipient, amount, bridge);
        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: rebalancer
        });
    }

    /// @dev Ensures that Router.domains() matches the domains that have a recipient or bridge.
    function _unenrollRemoteRouter(uint32 domain) internal override {
        delete allowedRecipient[domain];
        delete _allowedBridges[domain];
        Router._unenrollRemoteRouter(domain);
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
}
