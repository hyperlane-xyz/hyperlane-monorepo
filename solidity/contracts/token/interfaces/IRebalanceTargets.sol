// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/// @notice Authorizes rebalance recipients per domain beyond the enrolled
/// remote router, generalizing the single per-domain recipient override to a
/// set. Implemented by routers that allow rebalancing into multiple targets.
interface IRebalanceTargets {
    function isRebalanceTarget(
        uint32 domain,
        bytes32 target
    ) external view returns (bool);
}
