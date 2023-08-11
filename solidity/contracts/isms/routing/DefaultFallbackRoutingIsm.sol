// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";

contract DefaultFallbackRoutingIsm is DomainRoutingIsm {
    IMailbox public immutable mailbox;

    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    function module(uint32 origin)
        public
        view
        virtual
        returns (IInterchainSecurityModule)
    {
        (bool contained, bytes32 _module) = modules.tryGet(origin);
        if (contained) {
            return _module;
        } else {
            return mailbox.defaultIsm();
        }
    }
}
