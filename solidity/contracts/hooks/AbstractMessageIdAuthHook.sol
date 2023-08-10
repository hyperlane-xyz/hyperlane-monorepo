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
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {OPStackHookMetadata} from "../libs/hooks/OPStackHookMetadata.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/**
 * @title AbstractMessageIdAuthHook
 * @notice Message hook to inform an Abstract Message ID ISM of messages published through
 * a third-party bridge.
 * @dev V3 WIP
 */
abstract contract AbstractMessageIdAuthHook is
    IPostDispatchHook,
    MailboxClient
{
    using Message for bytes;

    // ============ Constants ============

    // address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Constructor ============

    constructor(
        address mailbox,
        uint32 _destinationDomain,
        address _ism
    ) MailboxClient(mailbox) {
        require(_ism != address(0), "invalid ISM");
        require(_destinationDomain != 0, "invalid destination domain");
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

    // ============ External functions ============

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * metadata The metadata for the hook caller
     * @param message The message being dispatched
     */
    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
        override
    {
        bytes32 id = message.id();
        require(
            isLatestDispatched(id),
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        require(
            message.destination() == destinationDomain,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            id
        );
        _sendMessageId(metadata, payload);
    }

    // ============ Internal functions ============

    /**
     * @notice Send a message to the ISM.
     * @param metadata The metadata for the hook caller
     * @param payload The payload for call to the ISM
     */
    function _sendMessageId(bytes calldata metadata, bytes memory payload)
        internal
        virtual;
}
