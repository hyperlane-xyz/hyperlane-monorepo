// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

// ============ External Imports ============

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbtractNativeISM
 * @notice Uses the native bridges to verify interchain messages.
 * @dev In the future, the hook might be moved inside the Mailbox which doesn't require storage mappings for senders.
 *      for more details see https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2381
 */
abstract contract AbstractNativeISM is
    IInterchainSecurityModule,
    Initializable
{
    // ============ Public Storage ============

    // mapping to check if the specific messageID from a specific sender has been received
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => mapping(address => bool)) public verifiedMessageIds;

    // ============ Events ============

    event ReceivedMessage(address indexed sender, bytes32 indexed messageId);

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

        return verifiedMessageIds[_messageId][_messageSender];
    }
}
