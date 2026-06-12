// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {TokenRouter} from "./TokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Router} from "../../client/Router.sol";
import {Quotes} from "./Quotes.sol";

struct MovableCollateralRouterStorage {
    // TODO: replace the single recipient override with a per-domain recipient
    // set when routes need multiple allowed same-chain rebalance recipients.
    mapping(uint32 routerDomain => bytes32 recipient) recipient;
    mapping(uint32 routerDomain => EnumerableSet.AddressSet bridges) bridges;
    EnumerableSet.AddressSet rebalancers;
}

abstract contract MovableCollateralRouter is TokenRouter {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using Quotes for Quote[];

    MovableCollateralRouterStorage internal allowed;

    event CollateralMoved(
        uint32 indexed domain,
        bytes32 recipient,
        uint256 amount,
        address indexed rebalancer
    );

    modifier onlyRebalancer() {
        require(isAllowedRebalancer(_msgSender()), "MCR: Only Rebalancer");
        _;
    }

    modifier onlyAllowedBridge(uint32 domain, ITokenBridge bridge) {
        EnumerableSet.AddressSet storage bridges = allowed.bridges[domain];
        require(bridges.contains(address(bridge)), "MCR: Not allowed bridge");
        _;
    }

    /// @notice Set of addresses that are allowed to rebalance.
    function allowedRebalancers() external view returns (address[] memory) {
        return allowed.rebalancers.values();
    }

    /// @notice Returns whether an address is allowed to rebalance.
    function isAllowedRebalancer(
        address rebalancer
    ) public view returns (bool) {
        return allowed.rebalancers.contains(rebalancer);
    }

    /// @notice Mapping of domain to allowed rebalance recipient.
    /// @dev Keys constrained to a subset of Router.domains()
    function allowedRecipient(uint32 domain) external view returns (bytes32) {
        return allowed.recipient[domain];
    }

    /// @notice Mapping of domain to allowed rebalance bridges.
    /// @dev Keys constrained to a subset of Router.domains()
    function allowedBridges(
        uint32 domain
    ) external view returns (address[] memory) {
        return allowed.bridges[domain].values();
    }

    function setRecipient(uint32 domain, bytes32 recipient) external onlyOwner {
        // constrain to a subset of Router.domains()
        _mustHaveRemoteRouter(domain);
        allowed.recipient[domain] = recipient;
    }

    function removeRecipient(uint32 domain) external onlyOwner {
        delete allowed.recipient[domain];
    }

    function addBridge(uint32 domain, ITokenBridge bridge) external onlyOwner {
        // constrain to a subset of Router.domains()
        _mustHaveRemoteRouter(domain);
        _addBridge(domain, bridge);
    }

    function _addBridge(uint32 domain, ITokenBridge bridge) internal virtual {
        allowed.bridges[domain].add(address(bridge));
    }

    function removeBridge(
        uint32 domain,
        ITokenBridge bridge
    ) external onlyOwner {
        _removeBridge(domain, bridge);
    }

    function _removeBridge(
        uint32 domain,
        ITokenBridge bridge
    ) internal virtual {
        allowed.bridges[domain].remove(address(bridge));
    }

    /**
     * @notice Clears legacy standing token approval for a bridge.
     * @custom:deprecated Despite the name this revokes rather than approves.
     *      `rebalance` grants exact per-call approval from the bridge quote;
     *      the selector is retained so existing upgrade / governance tooling
     *      stays compatible and can clear old max allowances.
     */
    function approveTokenForBridge(
        IERC20 token,
        ITokenBridge bridge
    ) external onlyOwner {
        // Revokes the allowance; it does not approve.
        token.forceApprove(address(bridge), 0);
    }

    function addRebalancer(address rebalancer) external onlyOwner {
        allowed.rebalancers.add(rebalancer);
    }

    function removeRebalancer(address rebalancer) external onlyOwner {
        allowed.rebalancers.remove(rebalancer);
    }

    /**
     * @notice Rebalances the collateral between router domains.
     * @param domain The domain to rebalance to.
     * @param collateralAmount The amount of collateral to rebalance.
     * @param bridge The bridge to use for the rebalance.
     * @dev The caller must be an allowed rebalancer and the bridge must be an allowed bridge for the domain.
     * @dev The recipient is the enrolled router if no recipient is set for the domain.
     */
    function rebalance(
        uint32 domain,
        uint256 collateralAmount,
        ITokenBridge bridge
    ) external payable onlyRebalancer onlyAllowedBridge(domain, bridge) {
        bytes32 recipient = _recipient(domain);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            domain,
            recipient,
            collateralAmount
        );

        address collateralToken = token();

        // charge the rebalancer any bridging fees denominated in the collateral
        // token to avoid undercollateralization
        uint256 collateralFees = quotes.extract(collateralToken);
        if (collateralFees > collateralAmount) {
            _transferFromSender(collateralFees - collateralAmount);
        }

        // need to handle native quote separately from collateral quote because
        // token() may be address(0), in which case we need to use address(this).balance
        // to move native collateral tokens across chains
        uint256 nativeFees = quotes.extract(address(0));
        if (nativeFees > address(this).balance) {
            revert("Rebalance native fee exceeds balance");
        }

        // Grant only the route collateral amount for this transfer. Expected
        // bridges consume the full quoted collateral allowance.
        if (collateralToken != address(0)) {
            IERC20(collateralToken).forceApprove(
                address(bridge),
                collateralFees
            );
        }

        bridge.transferRemote{value: nativeFees}(
            domain,
            recipient,
            collateralAmount
        );

        // Revoke any allowance the bridge did not consume.
        if (collateralToken != address(0)) {
            IERC20(collateralToken).forceApprove(address(bridge), 0);
        }

        emit CollateralMoved(domain, recipient, collateralAmount, msg.sender);
    }

    function _recipient(
        uint32 domain
    ) internal view returns (bytes32 recipient) {
        recipient = allowed.recipient[domain];
        if (recipient == bytes32(0)) {
            recipient = _mustHaveRemoteRouter(domain);
        }
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
        delete allowed.recipient[domain];
        _clear(allowed.bridges[domain]._inner);
        Router._unenrollRemoteRouter(domain);
    }
}
