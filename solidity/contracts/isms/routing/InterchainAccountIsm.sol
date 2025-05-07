// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {AbstractRoutingIsm} from "./AbstractRoutingIsm.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {InterchainAccountMessage} from "../../middleware/libs/InterchainAccountMessage.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title InterchainAccountIsm
 */
contract InterchainAccountIsm is AbstractRoutingIsm, PackageVersioned {
    using Message for bytes;
    using InterchainAccountMessage for bytes;

    IMailbox private immutable mailbox;

    // ============ Constructor ============
    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function route(
        bytes calldata _message
    ) public view virtual override returns (IInterchainSecurityModule) {
        address _ism = _message.body().ism();
        if (_ism == address(0)) {
            return mailbox.defaultIsm();
        } else {
            return IInterchainSecurityModule(_ism);
        }
    }
}
