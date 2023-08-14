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
import {AbstractMessageIdAuthHook} from "./AbstractMessageIdAuthHook.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {OPStackHookMetadata} from "../libs/hooks/OPStackHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OPStackHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native OPStack bridge.
 * @dev V3 WIP
 */
contract OPStackHook is AbstractMessageIdAuthHook {
    using OPStackHookMetadata for bytes;

    // ============ Constants ============

    ICrossDomainMessenger public immutable l1Messenger;

    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _ism,
        address _messenger
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(
            Address.isContract(_messenger),
            "ERC5164Hook: invalid dispatcher"
        );
        l1Messenger = ICrossDomainMessenger(_messenger);
    }

    function _sendMessageId(bytes calldata metadata, bytes memory payload)
        internal
        override
    {
        l1Messenger.sendMessage{value: metadata.msgValue()}(
            ism,
            payload,
            GAS_LIMIT
        );
    }
}
