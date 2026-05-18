// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Quote} from "../../interfaces/ITokenBridge.sol";

/// @notice A single externally executed swap step.
/// @dev
/// `target` is the contract called by the bridge.
/// `allowanceTarget` is the contract that may spend the bridge's current
/// `inputToken` balance for that step. This is usually the same router, but is
/// split out so routers that delegate transfer rights to another contract can
/// still be supported. Both addresses must be owner-whitelisted.
struct SwapCall {
    address target;
    address allowanceTarget;
    bytes data;
}

/// @notice In-flight rebalance state persisted across the router callback.
/// @dev
/// `requiredOut` is the nominal amount the destination router must receive
/// after applying standard `TokenRouter` scale math.
struct PendingRebalance {
    address initiator;
    address sourceRouter;
    address destinationRouter;
    address inputToken;
    address outputToken;
    uint32 localDomain;
    uint256 amountIn;
    uint256 minAmountOut;
    uint256 requiredOut;
    uint256 deadline;
}

/// @title ISwapRebalancingBridge
/// @notice Same-chain rebalance bridge that uses `MovableCollateralRouter` as
/// a collateral release primitive and settles into an enrolled destination
/// router after executing exact-input swap calls.
/// @dev
/// Intended usage:
/// - owner whitelists rebalancer EOAs, swap targets, and allowance targets
/// - rebalancer calls `executeRebalance(...)` with an enrolled destination
/// router plus exact-input swap calldata
/// - source router calls back into `quoteTransferRemote(...)` and
/// `transferRemote(...)`
/// - bridge pulls `amountIn` from the source router, executes swap calls, tops
/// up any output shortfall from the rebalancer, transfers exactly
/// `requiredOut` to the destination router, and refunds any surplus to the
/// rebalancer
///
/// Accepted tradeoffs:
/// - same-chain only
/// - single in-flight rebalance per bridge
/// - assumes standard `TokenRouter` scale math; custom inbound/outbound router
/// math is out of scope
/// - executor is intended for router-style exact-input swaps, not arbitrary
/// multi-step token choreography where the bridge itself must manage
/// intermediate-token balances
///
/// Trust assumptions:
/// - owner curates safe `target` / `allowanceTarget` allowlists
/// - authorized rebalancers choose economically sensible swap calldata and can
/// absorb output-token shortfalls
/// - source and destination routers expose honest token and scale parameters
/// - source router configuration still must allow `rebalance(localDomain,
/// amountIn, bridge)` to succeed
interface ISwapRebalancingBridge {
    /// @notice Starts a same-chain rebalance into an enrolled destination
    /// router.
    /// @dev
    /// `minAmountOut` protects the rebalancer, not LPs. LP protection comes
    /// from the bridge requiring the destination router to receive exactly
    /// `requiredOut`, with any shortfall pulled from the rebalancer in
    /// `outputToken`.
    function executeRebalance(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        SwapCall[] calldata swapCalls
    ) external;

    /// @notice Adds or removes a permitted rebalancer EOA.
    function setAuthorizedRebalancer(address rebalancer, bool allowed) external;

    /// @notice Adds or removes a permitted external call target.
    function setTarget(address target, bool allowed) external;

    /// @notice Adds or removes a permitted ERC20 allowance target.
    function setAllowanceTarget(address target, bool allowed) external;

    /// @notice Returns the current in-flight rebalance, if any.
    function pendingRebalance() external view returns (PendingRebalance memory);

    /// @notice Returns whether `destinationRouter` is enrolled on
    /// `sourceRouter` for its local domain.
    function isEnrolledDestination(
        address sourceRouter,
        address destinationRouter
    ) external view returns (bool);

    /// @notice Returns the nominal destination amount implied by router scale
    /// math.
    function requiredOut(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn
    ) external view returns (uint256);

    /// @notice Callback quote consumed by `MovableCollateralRouter.rebalance`.
    /// @dev The bridge returns only the source-token pull quote. The callback
    /// `recipient` is not authoritative for the bridge's destination selection.
    function quoteTransferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external view returns (Quote[] memory);
}
