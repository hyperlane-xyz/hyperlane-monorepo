// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {AbstractPredicateWrapper} from "../libs/AbstractPredicateWrapper.sol";

/**
 * @title PredicateRouterWrapper
 * @author Abacus Works
 * @notice Wraps an existing TokenRouter with Predicate attestation validation.
 *         Acts as BOTH a user entry point AND a post-dispatch hook.
 * @dev Security model:
 *      1. User calls transferRemoteWithAttestation() on this wrapper
 *      2. Wrapper validates attestation via PredicateClient, sets pendingAttestation = true
 *      3. Wrapper calls router.transferRemote()
 *      4. Router dispatches message, mailbox calls this contract's postDispatch()
 *      5. postDispatch() verifies pendingAttestation == true, then clears it
 *
 *      If someone bypasses wrapper and calls the router directly, postDispatch()
 *      will revert because pendingAttestation will be false.
 *
 * Usage:
 *      1. Deploy PredicateRouterWrapper pointing to existing warp route
 *      2. Set PredicateRouterWrapper as the hook on the warp route: router.setHook(predicateWrapper)
 *      3. Optionally aggregate with default hook for IGP using StaticAggregationHook
 *      4. Users call predicateWrapper.transferRemoteWithAttestation() instead of router.transferRemote()
 *
 * @custom:oz-version 4.9.x (uses Ownable without constructor argument)
 */
contract PredicateRouterWrapper is AbstractPredicateWrapper {
    // ============ Enums ============

    enum TokenType {
        Native,
        Synthetic,
        Collateral
    }

    // ============ Events ============

    /// @notice Emitted when a transfer is authorized via attestation
    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        string uuid
    );

    // ============ Constructor ============

    constructor(
        address _warpRoute,
        address _registry,
        string memory _policyID
    ) AbstractPredicateWrapper(_warpRoute, _registry, _policyID) {}

    // ============ Views ============

    function tokenType() public view returns (TokenType) {
        address tokenAddress = address(token);
        if (tokenAddress == address(0)) return TokenType.Native;
        if (tokenAddress == address(warpRoute)) return TokenType.Synthetic;
        return TokenType.Collateral;
    }

    // ============ Internal Overrides ============

    function _emitTransferAuthorized(
        address sender,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        string calldata uuid
    ) internal override {
        emit TransferAuthorized(sender, destination, recipient, amount, uuid);
    }
}
