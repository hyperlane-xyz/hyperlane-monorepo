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

import {Message} from "../libs/Message.sol";
import {GlobalHookMetadata} from "../libs/hooks/GlobalHookMetadata.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

contract ConfigFallbackDomainRoutingHook is
    AbstractPostDispatchHook,
    MailboxClient
{
    using Message for bytes;
    using GlobalHookMetadata for bytes;

    // ============ Public Storage ============

    /// @notice message sender => destination => recipient => hook
    mapping(address => mapping(uint32 => mapping(bytes32 => IPostDispatchHook)))
        public customHooks;

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    // ============ External Functions ============

    function setHook(
        uint32 destinationDomain,
        bytes32 recipient,
        IPostDispatchHook hook
    ) external {
        customHooks[msg.sender][destinationDomain][recipient] = hook;
    }

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        _getConfiguredHook(message).postDispatch{value: msg.value}(
            metadata,
            message
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(bytes calldata metadata, bytes calldata message)
        internal
        view
        override
        returns (uint256)
    {
        return _getConfiguredHook(message).quoteDispatch(metadata, message);
    }

    function _getConfiguredHook(bytes calldata message)
        internal
        view
        returns (IPostDispatchHook)
    {
        IPostDispatchHook configuredHook = customHooks[message.senderAddress()][
            message.destination()
        ][message.recipient()];
        if (address(configuredHook) == address(0)) {
            configuredHook = mailbox.defaultHook();
        }
        return configuredHook;
    }
}
