// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

abstract contract AbstractHook is MailboxClient, IPostDispatchHook {
    constructor(address mailbox) MailboxClient(mailbox) {}

    function postDispatch(bytes calldata message) external payable onlyMailbox {
        _postDispatch(message);
    }

    function _postDispatch(bytes calldata message) internal virtual;
}
