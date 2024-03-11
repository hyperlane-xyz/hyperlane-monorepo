// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

interface ILightClient {
    /// @notice Maps from a slot to a beacon block header root.
    function head() external view returns (uint256);

    /// @notice Maps from a slot to the current finalized ethereum1 execution state root.
    function executionStateRoots(uint256) external view returns (bytes32);

    /// @notice Maps from a period to the poseidon commitment for the sync committee.
    function syncCommitteePoseidons(uint256) external view returns (bytes32);

    function GENESIS_TIME() external view returns (uint256);

    function SECONDS_PER_SLOT() external view returns (uint256);

    function SLOTS_PER_PERIOD() external view returns (uint256);
}
