// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ERC5164MessageHook} from "../../hooks/ERC5164/ERC5164MessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractHookISM} from "./AbstractHookISM.sol";

// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ERC5164ISM
 * @notice Uses the generic eip-5164 standard to verify interchain messages.
 */
contract ERC5164ISM is AbstractHookISM {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);
    // corresponding 5164 executor address
    address public immutable executor;

    // ============ Modifiers ============

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    modifier isAuthorized() {
        require(
            msg.sender == executor,
            "ERC5164ISM: sender is not the executor"
        );
        _;
    }

    // ============ Constructor ============

    constructor(address _executor) {
        require(Address.isContract(_executor), "ERC5164ISM: invalid executor");
        executor = _executor;
    }

    // ============ External Functions ============

    /**
     * @notice Receive a message from the executor.
     * @param _sender Left-padded address of the sender.
     * @param _messageId Hyperlane ID for the message.
     */
    function verifyMessageId(bytes32 _sender, bytes32 _messageId)
        external
        isAuthorized
    {
        verifiedMessageIds[_messageId][_sender] = true;

        emit ReceivedMessage(_sender, _messageId);
    }
}
