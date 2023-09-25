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
import {StandardHookMetadata} from "../libs/hooks/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "./AbstractPostDispatchHook.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {DomainRoutingHook} from "./DomainRoutingHook.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

contract FallbackDomainRoutingHook is DomainRoutingHook {
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Constructor ============

    constructor(address _mailbox, address _owner)
        DomainRoutingHook(_mailbox, _owner)
    {}

    // ============ Internal Functions ============

    function _getConfiguredHook(bytes calldata message)
        internal
        view
        override
        returns (IPostDispatchHook)
    {
        IPostDispatchHook configuredHook = hooks[message.destination()];
        if (address(configuredHook) == address(0)) {
            configuredHook = mailbox.defaultHook();
        }
        return configuredHook;
    }
}
