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
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

// ============ External Imports ============

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ArbtractNativeISM
 * @notice Uses the native bridges to verify interchain messages.
 * @dev In the future, the hook might be moved inside the Mailbox which doesn't require storage mappings for senders.
 *      for more details see https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2381
 * @dev V3 WIP
 */
abstract contract AbstractHookISM is IInterchainSecurityModule, Initializable {
    // ============ Public Storage ============

    // Maps messageId to whether or not the sender attested to that message ID on the origin chain
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => bool) public verifiedMessageIds;
    // Address for Hook on L1 responsible for sending message via the Optimism bridge
    address public authorizedHook;

    // ============ Events ============

    event ReceivedMessage(bytes32 indexed messageId);

    // ============ Initializer ============

    function setAuthorizedHook(address _hook) external initializer {
        require(
            _hook != address(0),
            "AbstractNativeISM: invalid authorized hook"
        );
        authorizedHook = _hook;
    }

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

        return verifiedMessageIds[_messageId];
    }

    /**
     * @notice Receive a message from the L2 messenger.
     * @dev Only callable by the L2 messenger.
     * @param _messageId Hyperlane ID for the message.
     */
    function verifyMessageId(bytes32 _messageId) external virtual {
        _isAuthorized();

        verifiedMessageIds[_messageId] = true;
        emit ReceivedMessage(_messageId);
    }

    function _isAuthorized() internal view virtual;
}
