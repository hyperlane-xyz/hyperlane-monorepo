// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Message} from "../libs/Message.sol";

contract TestMessage {
    using Message for bytes;

    function body(bytes calldata _message)
        external
        pure
        returns (bytes calldata _body)
    {
        (, , , , _body) = _message.destructure();
    }

    function origin(bytes calldata _message)
        external
        pure
        returns (uint32 _origin)
    {
        (_origin, , , , ) = _message.destructure();
    }

    function sender(bytes calldata _message)
        external
        pure
        returns (bytes32 _sender)
    {
        (, _sender, , , ) = _message.destructure();
    }

    function destination(bytes calldata _message)
        external
        pure
        returns (uint32 _destination)
    {
        (, , _destination, , ) = _message.destructure();
    }

    function recipient(bytes calldata _message)
        external
        pure
        returns (bytes32 _recipient)
    {
        (, , , _recipient, ) = _message.destructure();
    }

    function recipientAddress(bytes calldata _message)
        external
        pure
        returns (address _recipient)
    {
        (, , , _recipient, ) = _message.destructureAddresses();
    }

    function leaf(bytes calldata _message, uint256 _leafIndex)
        external
        pure
        returns (bytes32)
    {
        return _message.leaf(_leafIndex);
    }
}
