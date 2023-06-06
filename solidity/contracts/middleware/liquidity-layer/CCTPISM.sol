// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICircleMessageTransmitter} from "./interfaces/circle/ICircleMessageTransmitter.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

/**
 * @title A contract that acts as both the ISM and the recipient of a cross-chain message from CCTPAdapter
 */
contract CCTPIsm is
    IInterchainSecurityModule,
    ISpecifiesInterchainSecurityModule,
    IMessageRecipient
{
    ICircleMessageTransmitter public cctpMessageTransmitter;

    constructor(ICircleMessageTransmitter _cctpMessageTransmitter) {
        cctpMessageTransmitter = _cctpMessageTransmitter;
    }

    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.CCTP);
    }

    /**
     * @notice Calls `ICircleMessageTransmitter.receiveMessage(_message, _attestation)`, which verifies the attestation
     * and sends tokens to recipient address.
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        // TODO: need to get attestation data from metadata
        // bytes memory attestation = _metadata.attestation();
        return cctpMessageTransmitter.receiveMessage(_message, _metadata);
    }

    function interchainSecurityModule()
        external
        view
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data
    ) external virtual override {
        // do nothing
    }
}
