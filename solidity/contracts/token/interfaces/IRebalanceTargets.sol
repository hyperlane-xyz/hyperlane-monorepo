// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/// @notice Authorizes same-chain rebalance destinations beyond the enrolled
/// remote router. Implemented by routers that allow rebalancing into multiple
/// local collateral targets.
interface IRebalanceTargets {
    function isRebalanceTarget(
        uint32 domain,
        bytes32 target
    ) external view returns (bool);
}
