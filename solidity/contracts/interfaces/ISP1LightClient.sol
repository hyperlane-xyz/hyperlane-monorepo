// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface ISP1LightClient {
    /// @notice The latest slot the light client has a finalized header for.
    function head() external view returns (uint256);

    /// @notice Maps from a slot to the current finalized ethereum1 execution state root.
    function executionStateRoots(uint256) external view returns (bytes32);

    /// @notice Maps from a period to the poseidon commitment for the sync committee.
    function syncCommitteePoseidons(uint256) external view returns (bytes32);

    function GENESIS_TIME() external view returns (uint256);

    function SECONDS_PER_SLOT() external view returns (uint256);

    function SLOTS_PER_PERIOD() external view returns (uint256);
}
