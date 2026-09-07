// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {ISP1LightClient} from "../interfaces/ISP1LightClient.sol";

contract MockLightClient is ISP1LightClient {
    bytes32 public immutable GENESIS_VALIDATORS_ROOT;
    uint256 public immutable GENESIS_TIME;
    uint256 public immutable SECONDS_PER_SLOT;
    uint256 public immutable SLOTS_PER_PERIOD;
    uint32 public immutable SOURCE_CHAIN_ID;
    uint16 public immutable FINALITY_THRESHOLD;

    /// @notice The latest slot the light client has a finalized header for.
    uint256 public head = 0;

    /// @notice Maps from a slot to the current finalized ethereum1 execution state root.
    mapping(uint256 => bytes32) public executionStateRoots;

    /// @notice Maps from a period to the poseidon commitment for the sync committee.
    mapping(uint256 => bytes32) public syncCommitteePoseidons;

    constructor(
        bytes32 genesisValidatorsRoot,
        uint256 genesisTime,
        uint256 secondsPerSlot,
        uint256 slotsPerPeriod,
        uint256 syncCommitteePeriod,
        bytes32 syncCommitteePoseidon,
        uint32 sourceChainId,
        uint16 finalityThreshold
    ) {
        GENESIS_VALIDATORS_ROOT = genesisValidatorsRoot;
        GENESIS_TIME = genesisTime;
        SECONDS_PER_SLOT = secondsPerSlot;
        SLOTS_PER_PERIOD = slotsPerPeriod;
        SOURCE_CHAIN_ID = sourceChainId;
        FINALITY_THRESHOLD = finalityThreshold;
        setSyncCommitteePoseidon(syncCommitteePeriod, syncCommitteePoseidon);
    }

    /// @notice Sets the sync committee poseidon for a given period.
    function setSyncCommitteePoseidon(
        uint256 period,
        bytes32 poseidon
    ) internal {
        syncCommitteePoseidons[period] = poseidon;
    }
}
