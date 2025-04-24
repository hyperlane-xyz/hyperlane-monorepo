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
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";
import {StandardHookMetadata} from "./StandardHookMetadata.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title AbstractMessageIdAuthHook
 * @notice Message hook to inform an Abstract Message ID ISM of messages published through
 * a third-party bridge.
 */
abstract contract AbstractMessageIdAuthHook is
    AbstractPostDispatchHook,
    MailboxClient
{
    using Address for address payable;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    // left-padded address for ISM to verify messages
    bytes32 public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism
    ) MailboxClient(_mailbox) {
        require(_ism != bytes32(0), "AbstractMessageIdAuthHook: invalid ISM");
        require(
            _destinationDomain != 0,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        ism = _ism;
        destinationDomain = _destinationDomain;
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure virtual returns (uint8) {
        return uint8(IPostDispatchHook.Types.ID_AUTH_ISM);
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        require(
            message.destination() == destinationDomain,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        require(
            metadata.msgValue(0) < 2 ** 255,
            "AbstractMessageIdAuthHook: msgValue must be less than 2 ** 255"
        );

        _sendMessageId(metadata, message);

        _refund(metadata, message, address(this).balance);
    }

    /**
     * @notice Send a message to the ISM.
     * @param metadata The metadata for the hook caller
     * @param message The message to send to the ISM
     */
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual;
}
