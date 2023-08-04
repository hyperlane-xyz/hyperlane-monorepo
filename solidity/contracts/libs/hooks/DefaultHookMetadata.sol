// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

/**
 * Format of metadata:
 *
 * [0:1] Variant to be used for custom configuration
 */
library DefaultHookMetadata {
    uint8 private constant VARIANT_OFFSET = 1;

    /**
     * @notice Returns the specified variant for the custom hook.
     * @param _metadata ABI encoded default hook metadata.
     * @return variant for the custom hook as uint8.
     */
    function variant(bytes calldata _metadata) internal pure returns (uint8) {
        return uint8(bytes1(_metadata[VARIANT_OFFSET:VARIANT_OFFSET + 1]));
    }
}
