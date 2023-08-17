// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IMailbox} from "../../Mailbox.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract DefaultFallbackRoutingIsm is DomainRoutingIsm {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using Address for address;
    using TypeCasts for bytes32;

    IMailbox public immutable mailbox;

    constructor(address _mailbox) {
        require(
            _mailbox.isContract(),
            "DefaultFallbackRoutingIsm: INVALID_MAILBOX"
        );
        mailbox = IMailbox(_mailbox);
    }

    function modules(uint32 origin)
        public
        view
        override
        returns (IInterchainSecurityModule)
    {
        (bool contained, bytes32 _module) = _modules.tryGet(origin);
        if (contained) {
            return IInterchainSecurityModule(_module.bytes32ToAddress());
        } else {
            return mailbox.defaultIsm();
        }
    }
}
