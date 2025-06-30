// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "../../client/Router.sol";
import {FungibleTokenRouter} from "./FungibleTokenRouter.sol";
import {ValueTransferBridge} from "../interfaces/ValueTransferBridge.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract MovableCollateralRouter is FungibleTokenRouter {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Mapping of domain to allowed rebalance recipient.
    /// @dev Keys constrained to a subset of Router.domains()
    mapping(uint32 routerDomain => bytes32 recipient) public allowedRecipient;

    /// @notice Mapping of domain to allowed rebalance bridges.
    /// @dev Keys constrained to a subset of Router.domains()
    mapping(uint32 routerDomain => EnumerableSet.AddressSet bridges)
        internal _allowedBridges;

    /// @notice Set of addresses that are allowed to rebalance.
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
        // constrain to a subset of Router.domains()
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
        // constrain to a subset of Router.domains()
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

    /**
     * @notice Rebalances the collateral between router domains.
     * @param domain The domain to rebalance to.
     * @param amount The amount of collateral to rebalance.
     * @param bridge The bridge to use for the rebalance.
     * @dev The caller must be an allowed rebalancer and the bridge must be an allowed bridge for the domain.
     * @dev The recipient is the enrolled router if no recipient is set for the domain.
     */
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

    /// @dev This function in `EnumerableSet` was introduced in OpenZeppelin v5. We are using 4.9
    /// See https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.3.0-rc.0/contracts/utils/structs/EnumerableSet.sol#L126
    function _clear(EnumerableSet.Set storage set) private {
        uint256 len = set._values.length;
        for (uint256 i = 0; i < len; ++i) {
            delete set._indexes[set._values[i]];
        }
        _unsafeSetLength(set._values, 0);
    }
    /// @dev A helper for `_clear`. See https://github.com/OpenZeppelin/openzeppelin-contracts/blob/39f5a0284e7eb539354e44b76fcbb69033b22b56/contracts/utils/Arrays.sol#L466
    function _unsafeSetLength(bytes32[] storage array, uint256 len) internal {
        assembly ("memory-safe") {
            sstore(array.slot, len)
        }
    }

    /// @dev Constrains keys of rebalance mappings to Router.domains()
    function _unenrollRemoteRouter(uint32 domain) internal override {
        delete allowedRecipient[domain];
        _clear(_allowedBridges[domain]._inner);
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
