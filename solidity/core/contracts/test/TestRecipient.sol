// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

contract TestRecipient is IMessageRecipient {
    bytes32 public lastSender;
    bytes public lastData;

    address public lastCaller;
    bytes public lastCalldata;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        string message
    );

    event ReceivedCall(address indexed caller, string message);

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data
    ) external override {
        emit ReceivedMessage(_origin, _sender, string(_data));
        lastSender = _sender;
        lastData = _data;
    }

    function handleCall(bytes calldata _data) external {
        emit ReceivedCall(msg.sender, string(_data));
        lastCaller = msg.sender;
        lastCalldata = _data;
    }
}
