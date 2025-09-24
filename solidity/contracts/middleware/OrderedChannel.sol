// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "../client/Router.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";

library OrderedMessage {
    // An ordered message is encoded as:
    // body (.)
    // nonce (4)
    // sender (32)
    // recipient (32)
    uint256 private constant NONCE_OFFSET = 0;
    uint256 private constant SENDER_OFFSET = 4;
    uint256 private constant RECIPIENT_OFFSET = 36;
    uint256 private constant SUFFIX_LENGTH = 68;

    function encode(
        bytes calldata body,
        uint32 nonce,
        bytes32 sender,
        bytes32 recipient
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(body, nonce, sender, recipient);
    }

    function decode(
        bytes calldata wrappedBody
    )
        internal
        pure
        returns (
            bytes calldata body,
            uint32 nonce,
            bytes32 sender,
            bytes32 recipient
        )
    {
        uint256 len = wrappedBody.length;
        require(len >= SUFFIX_LENGTH, "OrderedMessage: invalid length");

        uint256 bodyLen = len - SUFFIX_LENGTH;
        body = wrappedBody[0:bodyLen];

        bytes calldata suffix = wrappedBody[bodyLen:];
        nonce = uint32(bytes4(suffix[NONCE_OFFSET:NONCE_OFFSET + 4]));
        sender = bytes32(suffix[SENDER_OFFSET:SENDER_OFFSET + 32]);
        recipient = bytes32(suffix[RECIPIENT_OFFSET:RECIPIENT_OFFSET + 32]);
    }
}

contract OrderedChannel is Router {
    using OrderedMessage for bytes;
    using TypeCasts for bytes32;
    using TypeCasts for address;

    constructor(address _mailbox) Router(_mailbox) {}

    mapping(address sender => mapping(uint32 destination => mapping(bytes32 recipient => uint32)))
        public outboundNonces;

    mapping(uint32 origin => mapping(bytes32 sender => mapping(address recipient => uint32)))
        public inboundNonces;

    function dispatch(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        bytes calldata metadata,
        IPostDispatchHook hook
    ) external payable virtual returns (bytes32) {
        uint32 nonce = outboundNonces[msg.sender][destination][recipient]++;

        bytes32 sender = msg.sender.addressToBytes32();
        bytes memory wrappedBody = abi.encodePacked(
            body,
            nonce,
            sender,
            recipient
        );

        return
            _Router_dispatch(
                destination,
                msg.value,
                wrappedBody,
                metadata,
                address(hook)
            );
    }

    function _handle(
        uint32 origin,
        bytes32 _routerSender,
        bytes calldata wrappedBody
    ) internal virtual override {
        (
            bytes calldata body,
            uint32 nonce,
            bytes32 sender,
            bytes32 recipient
        ) = wrappedBody.decode();

        address recipientAddress = recipient.bytes32ToAddress();
        uint32 nextNonce = inboundNonces[origin][sender][recipientAddress]++;

        require(nonce == nextNonce, "Channel is strictly ordered");

        IMessageRecipient(recipientAddress).handle(origin, sender, body);
    }
}
