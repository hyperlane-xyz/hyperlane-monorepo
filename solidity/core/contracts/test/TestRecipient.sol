// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

contract TestRecipient is IMessageRecipient {
    bytes32 public lastSender;
    bytes public lastData;

    function handle(
        uint32,
        bytes32 _sender,
        bytes calldata _data
    ) external override {
        lastSender = _sender;
        lastData = _data;
    }
}
