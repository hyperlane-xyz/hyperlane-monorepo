// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {CONSISTENCY_LEVEL_CUSTOM, CONSISTENCY_LEVEL_INSTANT, CONSISTENCY_LEVEL_SAFE} from "wormhole-sdk/constants/ConsistencyLevel.sol";

/**
 * @notice Inputs for Wormhole EVM finality and optional custom handling.
 * @dev `customConsistencyLevel` is the official per-chain CCL contract, while
 * `baseConsistencyLevel` is one of Wormhole's standard EVM levels.
 */
struct WormholeConsistencyLevelConfig {
    uint8 consistencyLevel;
    address customConsistencyLevel;
    uint8 baseConsistencyLevel;
    uint16 additionalBlocks;
}

library CustomConsistencyLevelLib {
    uint8 internal constant INSTANT = CONSISTENCY_LEVEL_INSTANT;
    uint8 internal constant SAFE = CONSISTENCY_LEVEL_SAFE;
    // The SDK's generic finalized constant is 1. Wormhole's EVM-specific
    // finalized tag is 202.
    uint8 internal constant FINALIZED = 202;
    uint8 internal constant CUSTOM = CONSISTENCY_LEVEL_CUSTOM;

    function isStandardEvmLevel(uint8 level) internal pure returns (bool) {
        return level == INSTANT || level == SAFE || level == FINALIZED;
    }
}
