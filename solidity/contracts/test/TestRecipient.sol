// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

contract TestRecipient is
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    IInterchainSecurityModule public interchainSecurityModule;
    bytes32 public lastSender;
    bytes public lastData;

    address public lastCaller;
    string public lastCallMessage;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        string message
    );

    event ReceivedCall(address indexed caller, uint256 amount, string message);

    function setInterchainSecurityModule(address _ism) external {
        interchainSecurityModule = IInterchainSecurityModule(_ism);
    }

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data
    ) external virtual override {
        emit ReceivedMessage(_origin, _sender, string(_data));
        lastSender = _sender;
        lastData = _data;
    }

    function fooBar(uint256 amount, string calldata message) external {
        emit ReceivedCall(msg.sender, amount, message);
        lastCaller = msg.sender;
        lastCallMessage = message;
    }
}
