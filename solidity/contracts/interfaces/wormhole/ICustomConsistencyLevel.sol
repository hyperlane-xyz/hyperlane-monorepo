// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

/**
 * @title ICustomConsistencyLevel
 * @notice Wormhole registry queried by Guardians when an emitter publishes
 * with consistency level 203.
 * @dev Configurations are keyed by `msg.sender`, so the emitting router must
 * call `configure` itself.
 */
interface ICustomConsistencyLevel {
    function configure(bytes32 config) external;

    function getConfiguration(
        address emitterAddress
    ) external view returns (bytes32);
}
