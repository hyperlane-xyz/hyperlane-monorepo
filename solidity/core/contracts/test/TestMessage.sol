// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";

contract TestMessage {
    using Message for bytes;

    function body(bytes calldata _message) external pure returns (bytes memory) {
        return _message.body();
    }

    function origin(bytes calldata _message) external pure returns (uint32) {
        return _message.origin();
    }

    function sender(bytes calldata _message) external pure returns (bytes32) {
        return _message.sender();
    }

    function destination(bytes calldata _message) external pure returns (uint32) {
        return _message.destination();
    }

    function recipient(bytes calldata _message) external pure returns (bytes32) {
        return _message.recipient();
    }

    function recipientAddress(bytes calldata _message)
        external
        pure
        returns (address)
    {
        return _message.recipientAddress();
    }

    function leaf(bytes calldata _message, uint256 _leafIndex)
        external
        pure
        returns (bytes32)
    {
        return _message.leaf(_leafIndex);
    }
}
