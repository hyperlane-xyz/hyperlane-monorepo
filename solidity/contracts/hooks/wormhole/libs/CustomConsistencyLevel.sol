// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {CONSISTENCY_LEVEL_CUSTOM, CONSISTENCY_LEVEL_INSTANT, CONSISTENCY_LEVEL_SAFE} from "wormhole-sdk/constants/ConsistencyLevel.sol";

/**
 * @notice Wormhole EVM publication level and, when custom, its Guardian policy.
 * @dev Custom policies start at `customBaseConsistencyLevel`, then wait
 * `additionalBlocks`. The other custom fields must be zero for standard levels.
 */
struct WormholeConsistencyLevelConfig {
    /// @notice Level used by this EVM hook to publish through Wormhole Core.
    uint8 consistencyLevel;
    /// @notice Official CCL contract on this chain.
    /// @dev Must be `address(0)` unless `consistencyLevel` is `CUSTOM`.
    address customConsistencyLevelContract;
    /// @notice Level Guardians reach before waiting `additionalBlocks`.
    /// @dev Must be `0` unless `consistencyLevel` is `CUSTOM`.
    uint8 customBaseConsistencyLevel;
    /// @notice Number of blocks Guardians wait after reaching
    /// `customBaseConsistencyLevel`.
    /// @dev Must be `0` unless `consistencyLevel` is `CUSTOM`.
    uint16 additionalBlocks;
}

/**
 * @notice Wormhole EVM consistency constants and constructor validation rules.
 * @dev This allowlist catches likely configuration mistakes. It does not imply
 * that every listed behavior is available on every EVM chain.
 * See https://wormhole.com/docs/products/reference/consistency-levels/ for
 * Wormhole's per-chain support table.
 */
library CustomConsistencyLevelLib {
    /// @dev Documented value 0: wait for the source chain's finalized state.
    uint8 internal constant ZERO_FINALIZED = 0;
    /// @dev Guardian sentinel 200: observe the latest block.
    uint8 internal constant INSTANT = CONSISTENCY_LEVEL_INSTANT;
    /// @dev Guardian sentinel 201: observe the chain's safe block.
    uint8 internal constant SAFE = CONSISTENCY_LEVEL_SAFE;
    /// @dev Guardian sentinel 202: explicitly observe the finalized block.
    uint8 internal constant GUARDIAN_FINALIZED = 202;
    /// @dev Guardian sentinel 203: read the emitter's configuration from CCL.
    uint8 internal constant CUSTOM = CONSISTENCY_LEVEL_CUSTOM;

    /// @notice Whether `level` may be assigned to `consistencyLevel`.
    /// @dev Accepts the documented finalized value 0 and EVM Guardian
    /// sentinels 200 through 203.
    function isAllowedConsistencyLevel(
        uint8 level
    ) internal pure returns (bool) {
        return
            level == ZERO_FINALIZED ||
            level == CUSTOM ||
            isAllowedCustomBaseConsistencyLevel(level);
    }

    /// @notice Whether `level` may be assigned to `customBaseConsistencyLevel`.
    /// @dev Guardian CCL only accepts sentinels 200, 201, and 202 here.
    function isAllowedCustomBaseConsistencyLevel(
        uint8 level
    ) internal pure returns (bool) {
        return level == INSTANT || level == SAFE || level == GUARDIAN_FINALIZED;
    }
}
