// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OptimismISM
 * @notice Uses the native Optimism bridge to verify interchain messages.
 */
contract OptimismISM is IInterchainSecurityModule, Ownable {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISM);

    // Optimism's native CrossDomainMessenger deployed on L2
    // @dev Only allowed to call `receiveFromHook`.
    ICrossDomainMessenger public immutable l2Messenger;

    // ============ Public Storage ============

    // Hook deployed on L1 responsible for sending message via the Optimism bridge
    IOptimismMessageHook public l1Hook;
    // mapping to check if the specific messageID from a specific emitter has been received
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    // ============ Events ============

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    // ============ Modifiers ============

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        ICrossDomainMessenger _l2Messenger = l2Messenger;

        require(
            msg.sender == address(_l2Messenger),
            "OptimismISM: caller is not the messenger"
        );

        require(
            _l2Messenger.xDomainMessageSender() == address(l1Hook),
            "OptimismISM: caller is not the owner"
        );
        _;
    }

    // ============ Constructor ============

    constructor(address _l2Messenger) {
        require(_l2Messenger != address(0), "OptimismISM: invalid messenger");

        l2Messenger = ICrossDomainMessenger(_l2Messenger);
    }

    // ============ External Functions ============

    /**
     * @notice Set the hook responsible for sending messages from L1.
     * @param _hook Address of the hook.
     */
    function setOptimismHook(address _hook) external onlyOwner {
        require(_hook != address(0), "OptimismISM: invalid hook");

        l1Hook = IOptimismMessageHook(_hook);
    }

    /**
     * @notice Receive a message from the L2 messenger.
     * @dev Only callable by the L2 messenger.
     * @param _emitter Address of the emitter.
     * @param _messageId Hyperlane ID for the message.
     */
    function receiveFromHook(address _emitter, bytes32 _messageId)
        external
        isAuthorized
    {
        require(_emitter != address(0), "OptimismISM: invalid emitter");

        receivedEmitters[_messageId][_emitter] = true;

        emit ReceivedMessage(_messageId, _emitter);
    }

    /**
     * @notice Verify a message was received by ISM.
     * @param _message Message to verify.
     */
    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external view returns (bool) {
        bytes32 _messageId = Message.id(_message);
        address _messageSender = Message.senderAddress(_message);

        return receivedEmitters[_messageId][_messageSender];
    }
}
