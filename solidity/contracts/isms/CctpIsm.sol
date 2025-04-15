// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "../token/libs/TokenRouter.sol";
import {CctpMessageV2} from "../libs/CctpMessageV2.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "./ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../interfaces/isms/ICcipReadIsm.sol";
import {TypedMemView} from "@memview-sol/contracts/TypedMemView.sol";
import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";

contract CctpIsm is AbstractCcipReadIsm {
    using TypeCasts for address;
    using Message for bytes;
    using CctpMessageV2 for bytes29;

    string[] urls;
    IMailbox mailbox;
    IMessageTransmitter messageTransmitter;

    error UnsupportedCCTPVersion(uint32);

    constructor(
        string[] memory _urls,
        address _cctpMessageTransmitter,
        address _mailbox
    ) {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
        mailbox = IMailbox(_mailbox);
        messageTransmitter = IMessageTransmitter(_cctpMessageTransmitter);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("getCCTPAttestation(bytes)", _message),
            CctpIsm.process.selector,
            _message
        );
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) external returns (bool) {
        (bytes memory cctpMessage, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        // Receive only if the nonce hasn't been used before
        if (!_isMessageReceived(cctpMessage)) {
            messageTransmitter.receiveMessage(cctpMessage, attestation);
        }

        return true;
    }

    function _isMessageReceived(
        bytes memory cctpMessage
    ) internal returns (bool isNonceUsed) {
        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);
        uint32 version = originalMsg._getVersion();
        if (version == 0) {
            // CCTP v1 message
            uint64 nonce = originalMsg._getNonceV1();
            uint32 source = originalMsg._getSourceDomain();
            bytes32 hash = keccak256(abi.encodePacked(source, nonce));

            isNonceUsed = messageTransmitter.usedNonces(hash) != 0;
        } else if (version == 1) {
            // CCTP v2 message
            bytes32 nonce = originalMsg._getNonce();
            isNonceUsed = messageTransmitter.usedNonces(nonce) != 0;
        } else {
            revert UnsupportedCCTPVersion(version);
        }
    }
}
