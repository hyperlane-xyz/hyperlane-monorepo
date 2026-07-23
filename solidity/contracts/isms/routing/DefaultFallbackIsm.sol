// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "./AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title DefaultFallbackIsm
 * @notice Ownerless routing ISM that always defers to the mailbox's default ISM.
 */
contract DefaultFallbackIsm is AbstractRoutingIsm, PackageVersioned {
    IMailbox public immutable mailbox;

    constructor(address _mailbox) {
        require(
            Address.isContract(_mailbox),
            "DefaultFallbackIsm: invalid mailbox"
        );
        mailbox = IMailbox(_mailbox);
    }

    function route(
        bytes calldata
    ) public view override returns (IInterchainSecurityModule) {
        return mailbox.defaultIsm();
    }
}
