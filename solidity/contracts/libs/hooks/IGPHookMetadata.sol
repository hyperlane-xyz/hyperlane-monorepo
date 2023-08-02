// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 *
 * [0:32] Gas amount for message
 * [33:52] Refund address for message
 */
library IGPHookMetadata {
    function gasAmount(bytes calldata _metadata)
        internal
        pure
        returns (uint256)
    {
        return uint256(bytes32(_metadata[0:32]));
    }

    function refundAddress(bytes calldata _metadata)
        internal
        pure
        returns (address)
    {
        return address(bytes20(_metadata[33:52]));
    }
}
