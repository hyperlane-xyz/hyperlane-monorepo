// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

interface ICircleMessageTransmitter {
    /**
     * @notice Receive a message. Messages with a given nonce
     * can only be broadcast once for a (sourceDomain, destinationDomain)
     * pair. The message body of a valid message is passed to the
     * specified recipient for further processing.
     *
     * @dev Attestation format:
     * A valid attestation is the concatenated 65-byte signature(s) of exactly
     * `thresholdSignature` signatures, in increasing order of attester address.
     * ***If the attester addresses recovered from signatures are not in
     * increasing order, signature verification will fail.***
     * If incorrect number of signatures or duplicate signatures are supplied,
     * signature verification will fail.
     *
     * Message format:
     * Field Bytes Type Index
     * version 4 uint32 0
     * sourceDomain 4 uint32 4
     * destinationDomain 4 uint32 8
     * nonce 8 uint64 12
     * sender 32 bytes32 20
     * recipient 32 bytes32 52
     * messageBody dynamic bytes 84
     * @param _message Message bytes
     * @param _attestation Concatenated 65-byte signature(s) of `_message`, in increasing order
     * of the attester address recovered from signatures.
     * @return success bool, true if successful
     */
    function receiveMessage(bytes memory _message, bytes calldata _attestation)
        external
        returns (bool success);

    function usedNonces(bytes32 _nonceId) external view returns (bool);
}
