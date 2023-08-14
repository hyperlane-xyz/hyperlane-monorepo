// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * Format of metadata:
 *
 * [0:20] sender address for refunds
 */
library ProtocolFeeMetadata {
    uint8 private constant SENDER_ADDRESS_OFFSET = 0;

    function senderAddress(bytes calldata _metadata)
        internal
        pure
        returns (address)
    {
        return
            address(
                bytes20(
                    _metadata[SENDER_ADDRESS_OFFSET:SENDER_ADDRESS_OFFSET + 20]
                )
            );
    }

    function hasSenderAddress(bytes calldata _metadata)
        internal
        pure
        returns (bool)
    {
        return _metadata.length == 20 && senderAddress(_metadata) != address(0);
    }
}
