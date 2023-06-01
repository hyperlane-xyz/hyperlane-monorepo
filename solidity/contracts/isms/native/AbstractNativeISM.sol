// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

// ============ External Imports ============

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CrossChainEnabledOptimism} from "@openzeppelin/contracts/crosschain/optimism/CrossChainEnabledOptimism.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbtractNativeISM
 * @notice Uses the native bridges to verify interchain messages.
 */
abstract contract AbstractNativeISM is IInterchainSecurityModule, Ownable {
    // ============ Public Storage ============

    // mapping to check if the specific messageID from a specific emitter has been received
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    // ============ Events ============

    event ReceivedMessage(address indexed emitter, bytes32 indexed messageId);

    // ============ External Functions ============

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

    // ============ Internal Functions ============

    function _setEmitter(address _emitter, bytes32 _messageId) internal {
        receivedEmitters[_messageId][_emitter] = true;
    }
}
