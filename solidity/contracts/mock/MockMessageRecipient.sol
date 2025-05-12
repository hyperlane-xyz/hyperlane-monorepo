pragma solidity ^0.8.0;

import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";

contract MockMessageRecipient is IMessageRecipient {
    event MessageHandled(
        uint32 indexed origin,
        bytes32 indexed sender,
        bytes message,
        uint256 value
    );

    // Store the last received message details
    uint32 public lastOrigin;
    bytes32 public lastSender;
    bytes public lastMessageBody;
    uint256 public lastValue;

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _body
    ) external payable override {
        lastOrigin = _origin;
        lastSender = _sender;
        lastMessageBody = _body;
        lastValue = msg.value;
        emit MessageHandled(_origin, _sender, _body, msg.value);
    }
}
