// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IMailbox} from "../../Mailbox.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

contract DefaultFallbackRoutingIsm is DomainRoutingIsm {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using TypeCasts for bytes32;

    IMailbox public immutable mailbox;

    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    function module(uint32 origin)
        public
        view
        override
        returns (IInterchainSecurityModule)
    {
        (bool contained, bytes32 _module) = modules.tryGet(origin);
        if (contained) {
            return IInterchainSecurityModule(_module.bytes32ToAddress());
        } else {
            return mailbox.defaultIsm();
        }
    }
}
