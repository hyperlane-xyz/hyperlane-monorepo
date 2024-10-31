// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title Hyperlane OPL2ToL1Metadata Library
 * @notice Library for formatted metadata used by OPL2ToL1Ism
 */
library OPL2ToL1Metadata {
    // bottom offset to the start of message id in the metadata
    uint256 private constant MESSAGE_ID_OFFSET = 120;
    // from IOptimismPortal.WithdrawalTransaction
    // Σ {
    //      nonce                          = 32 bytes
    //      PADDING + sender               = 32 bytes
    //      PADDING + target               = 32 bytes
    //      value                          = 32 bytes
    //      gasLimit                       = 32 bytes
    //      _data
    //          OFFSET                      = 32 bytes
    //          LENGTH                      = 32 bytes
    // } = 252 bytes
    uint256 private constant FIXED_METADATA_LENGTH = 252;
    // metadata here is double encoded call relayMessage(..., preVerifyMessage)
    // Σ {
    //      _selector                       =  4 bytes
    //      _nonce                          = 32 bytes
    //      PADDING + _sender               = 32 bytes
    //      PADDING + _target               = 32 bytes
    //      _value                          = 32 bytes
    //      _minGasLimit                    = 32 bytes
    //      _data
    //          OFFSET                      = 32 bytes
    //          LENGTH                      = 32 bytes
    //          PADDING + preVerifyMessage   = 96 bytes
    // } = 324 bytes
    uint256 private constant MESSENGER_CALLDATA_LENGTH = 324;

    /**
     * @notice Returns the message ID.
     * @param _metadata OptimismPortal.WithdrawalTransaction encoded calldata
     * @return ID of `_metadata`
     */
    function messageId(
        bytes calldata _metadata
    ) internal pure returns (bytes32) {
        uint256 metadataLength = _metadata.length;
        return
            bytes32(
                _metadata[metadataLength - MESSAGE_ID_OFFSET:metadataLength -
                    MESSAGE_ID_OFFSET +
                    32]
            );
    }

    function checkCalldataLength(
        bytes calldata _metadata
    ) internal pure returns (bool) {
        return
            _metadata.length ==
            MESSENGER_CALLDATA_LENGTH + FIXED_METADATA_LENGTH;
    }
}
