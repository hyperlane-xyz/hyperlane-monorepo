// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICircleMessageTransmitter} from "./interfaces/circle/ICircleMessageTransmitter.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

/**
 * Format of metadata:
 * [   0:  248] CCTP Burn message
 * [ 248:  280] Attestation
 */
contract CctpIsm is IInterchainSecurityModule {
    uint8 private constant CCTP_MESSAGE_OFFSET = 0;
    uint8 private constant CCTP_ATTESTATION_OFFSET = 248;

    ICircleMessageTransmitter public cctpMessageTransmitter;

    constructor(ICircleMessageTransmitter _cctpMessageTransmitter) {
        cctpMessageTransmitter = _cctpMessageTransmitter;
    }

    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.CCTP);
    }

    /**
     * @notice Calls `ICircleMessageTransmitter.receiveMessage(_message, _attestation)`, which verifies the attestation
     * and sends tokens to the recipient address.
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        bytes
            memory message = _metadata[CCTP_MESSAGE_OFFSET:CCTP_ATTESTATION_OFFSET];
        bytes
            memory metadata = _metadata[CCTP_ATTESTATION_OFFSET:CCTP_ATTESTATION_OFFSET +
                32];
        return cctpMessageTransmitter.receiveMessage(message, metadata);
    }
}
