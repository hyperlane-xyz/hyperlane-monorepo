// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract OptimismIsm is IInterchainSecurityModule, Ownable {
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        ICrossDomainMessenger _l2Messenger = l2Messenger;

        require(
            msg.sender == address(_l2Messenger),
            "OptimismIsm: caller is not the messenger"
        );

        require(
            _l2Messenger.xDomainMessageSender() == address(hook),
            "OptimismIsm: caller is not the owner"
        );

        _;
    }

    constructor(ICrossDomainMessenger _l2Messenger) {
        l2Messenger = _l2Messenger;
    }

    ICrossDomainMessenger public immutable l2Messenger;
    IOptimismMessageHook public hook;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISM);

    function setOptimismHook(IOptimismMessageHook _hook) external onlyOwner {
        hook = _hook;
    }

    function receiveFromHook(bytes32 _messageId, address _emitter)
        external
        isAuthorized
    {
        require(_emitter != address(0), "OptimismIsm: invalid emitter");

        receivedEmitters[_messageId][_emitter] = true;

        emit ReceivedMessage(_messageId, _emitter);
    }

    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external view returns (bool messageVerified) {
        bytes32 _messageId = Message.id(_message);
        address _messageSender = Message.senderAddress(_message);

        messageVerified = receivedEmitters[_messageId][_messageSender];
    }
}
