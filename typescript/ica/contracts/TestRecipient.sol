// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

contract TestRecipient {
    address public lastSender;
    bytes public lastData;

    function foo(bytes calldata data) external {
        lastSender = msg.sender;
        lastData = data;
    }
}
