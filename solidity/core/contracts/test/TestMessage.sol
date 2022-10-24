// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Message} from "../libs/Message.sol";

contract TestMessage {
    using Message for bytes;

    function version(bytes calldata _message)
        external
        pure
        returns (uint32 _version)
    {
        return _message.version();
    }

    function nonce(bytes calldata _message)
        external
        pure
        returns (uint256 _nonce)
    {
        return _message.nonce();
    }

    function body(bytes calldata _message)
        external
        pure
        returns (bytes calldata _body)
    {
        return _message.body();
    }

    function origin(bytes calldata _message)
        external
        pure
        returns (uint32 _origin)
    {
        return _message.origin();
    }

    function sender(bytes calldata _message)
        external
        pure
        returns (bytes32 _sender)
    {
        return _message.sender();
    }

    function destination(bytes calldata _message)
        external
        pure
        returns (uint32 _destination)
    {
        return _message.destination();
    }

    function recipient(bytes calldata _message)
        external
        pure
        returns (bytes32 _recipient)
    {
        return _message.recipient();
    }

    function recipientAddress(bytes calldata _message)
        external
        pure
        returns (address _recipient)
    {
        return _message.recipientAddress();
    }

    function id(bytes calldata _message) external pure returns (bytes32) {
        return _message.id();
    }
}
