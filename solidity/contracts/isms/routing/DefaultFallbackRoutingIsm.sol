// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract DefaultFallbackRoutingIsm is DomainRoutingIsm, MailboxClient {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using Address for address;
    using TypeCasts for bytes32;

    constructor(
        address _mailbox,
        address _owner,
        uint32[] memory _domains,
        IInterchainSecurityModule[] memory _modules
    ) MailboxClient(_mailbox) {
        require(_domains.length == _modules.length, "length mismatch");
        for (uint256 i = 0; i < _domains.length; i++) {
            _set(_domains[i], address(_modules[i]));
        }
        _transferOwnership(_owner);
        _disableInitializers();
    }

    function module(
        uint32 origin
    ) public view override returns (IInterchainSecurityModule) {
        (bool contained, bytes32 _module) = _modules.tryGet(origin);
        if (contained) {
            return IInterchainSecurityModule(_module.bytes32ToAddress());
        } else {
            return mailbox.defaultIsm();
        }
    }
}
