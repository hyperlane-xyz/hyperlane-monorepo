// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {CONSISTENCY_LEVEL_CUSTOM, CONSISTENCY_LEVEL_FINALIZED, CONSISTENCY_LEVEL_INSTANT, CONSISTENCY_LEVEL_SAFE} from "wormhole-sdk/constants/ConsistencyLevel.sol";

/**
 * @notice Inputs for a Wormhole EVM consistency level and optional custom handling.
 * @dev `customConsistencyLevelContract` is the official per-chain CCL
 * contract. `baseConsistencyLevel` must be one of the consistency levels
 * recognized by Wormhole's Guardian CCL implementation.
 */
struct WormholeConsistencyLevelConfig {
    /// @notice Consistency level used when publishing the Hyperlane message
    /// commitment through Wormhole Core.
    uint8 consistencyLevel;
    /// @notice Official CCL contract on this chain.
    /// @dev Must be `address(0)` unless `consistencyLevel` is `CUSTOM`.
    address customConsistencyLevelContract;
    /// @notice Guardian consistency sentinel that must be reached before
    /// `additionalBlocks` starts counting.
    /// @dev Must be `0` unless `consistencyLevel` is `CUSTOM`.
    uint8 baseConsistencyLevel;
    /// @notice Number of blocks Guardians wait after reaching
    /// `baseConsistencyLevel`.
    /// @dev Must be `0` unless `consistencyLevel` is `CUSTOM`.
    uint16 additionalBlocks;
}

/**
 * @notice Wormhole consistency constants and constructor validation rules.
 * @dev This allowlist catches likely configuration mistakes. It does not imply
 * that every listed behavior is available on every EVM chain.
 * See https://wormhole.com/docs/products/reference/consistency-levels/ for
 * Wormhole's per-chain support table.
 */
library CustomConsistencyLevelLib {
    /// @dev Wait for the source chain's finalized state on chains that support.
    uint8 internal constant ZERO_FINALIZED = 0;
    /// @dev Guardian sentinel 200: observe the latest block.
    uint8 internal constant INSTANT = CONSISTENCY_LEVEL_INSTANT;
    /// @dev Guardian sentinel 201: observe the chain's safe block.
    uint8 internal constant SAFE = CONSISTENCY_LEVEL_SAFE;
    /// @dev The Solidity SDK's finalized value, 1. EVM Guardians do not assign
    /// it special behavior, so their fallback treats it as finalized.
    uint8 internal constant SDK_FINALIZED = CONSISTENCY_LEVEL_FINALIZED;
    /// @dev Guardian sentinel 202: explicitly observe the finalized block.
    uint8 internal constant GUARDIAN_FINALIZED = 202;
    /// @dev Guardian sentinel 203: read the emitter's configuration from CCL.
    uint8 internal constant CUSTOM = CONSISTENCY_LEVEL_CUSTOM;

    /// @notice Whether `level` may be assigned to `consistencyLevel`.
    /// @dev Accepts both finalized encodings for Solidity SDK compatibility.
    function isAllowedConsistencyLevel(
        uint8 level
    ) internal pure returns (bool) {
        return
            level == ZERO_FINALIZED ||
            level == SDK_FINALIZED ||
            level == CUSTOM ||
            isAllowedCustomBaseConsistencyLevel(level);
    }

    /// @notice Whether `level` may be assigned to `baseConsistencyLevel`.
    /// @dev Guardian CCL only accepts sentinels 200, 201, and 202 here. The SDK
    /// finalized value 1 and another custom level are intentionally excluded.
    function isAllowedCustomBaseConsistencyLevel(
        uint8 level
    ) internal pure returns (bool) {
        return level == INSTANT || level == SAFE || level == GUARDIAN_FINALIZED;
    }
}
