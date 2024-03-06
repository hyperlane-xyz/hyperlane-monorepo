// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

interface ILightClient {
    /// @notice Maps from a slot to a beacon block header root.
    function head() external view returns (uint256);

    /// @notice Maps from a slot to the current finalized ethereum1 execution state root.
    function executionStateRoots(uint256) external view returns (bytes32);
}
