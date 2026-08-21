// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

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
    uint8 internal constant INSTANT = 200;
    uint8 internal constant SAFE = 201;
    uint8 internal constant FINALIZED = 202;
    uint8 internal constant CUSTOM = 203;

    /// @dev Wormhole's additional-blocks configuration type.
    uint8 internal constant ADDITIONAL_BLOCKS_TYPE = 1;

    function isStandardEvmLevel(uint8 level) internal pure returns (bool) {
        return level == INSTANT || level == SAFE || level == FINALIZED;
    }

    /**
     * @dev Wormhole encodes this as: type (u8), base level (u8), additional
     * blocks (big-endian u16), then 28 zero bytes.
     */
    function encodeAdditionalBlocks(
        uint8 baseConsistencyLevel,
        uint16 additionalBlocks
    ) internal pure returns (bytes32) {
        return
            bytes32(
                abi.encodePacked(
                    ADDITIONAL_BLOCKS_TYPE,
                    baseConsistencyLevel,
                    additionalBlocks,
                    bytes28(0)
                )
            );
    }
}
