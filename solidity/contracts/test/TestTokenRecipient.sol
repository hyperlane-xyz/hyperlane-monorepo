// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ILiquidityLayerMessageRecipient} from "../interfaces/ILiquidityLayerMessageRecipient.sol";

contract TestTokenRecipient is ILiquidityLayerMessageRecipient {
    bytes32 public lastSender;
    bytes public lastData;
    address public lastToken;
    uint256 public lastAmount;

    address public lastCaller;
    string public lastCallMessage;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        string message,
        address token,
        uint256 amount
    );

    event ReceivedCall(address indexed caller, uint256 amount, string message);

    function handleWithTokens(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data,
        address _token,
        uint256 _amount
    ) external override {
        emit ReceivedMessage(_origin, _sender, string(_data), _token, _amount);
        lastSender = _sender;
        lastData = _data;
        lastToken = _token;
        lastAmount = _amount;
    }

    function fooBar(uint256 amount, string calldata message) external {
        emit ReceivedCall(msg.sender, amount, message);
        lastCaller = msg.sender;
        lastCallMessage = message;
    }
}
