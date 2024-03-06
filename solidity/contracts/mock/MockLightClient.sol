// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {ILightClient} from "../interfaces/ccip-gateways/ILightClient.sol";

contract MockLightClient is ILightClient {
    /// @notice The latest slot the light client has a finalized header for.
    uint256 public head = 0;

    /// @notice Maps from a slot to the current finalized ethereum1 execution state root.
    mapping(uint256 => bytes32) public executionStateRoots;
}
