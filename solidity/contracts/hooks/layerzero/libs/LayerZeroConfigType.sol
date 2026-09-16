// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

/**
 * @notice ULN302 configuration tags, independent of send/receive direction.
 * @dev Receive libraries accept only `ULN`; send libraries accept both tags.
 */
library LayerZeroConfigTypeLib {
    uint32 internal constant EXECUTOR = 1;
    uint32 internal constant ULN = 2;

    /// @notice Whether `configType` is a recognized ULN302 tag.
    function isValid(uint32 configType) internal pure returns (bool) {
        return configType == EXECUTOR || configType == ULN;
    }
}
