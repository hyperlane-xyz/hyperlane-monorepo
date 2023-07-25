// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IMailbox} from "../interfaces/IMailbox.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

abstract contract MailboxClient {
    IMailbox immutable mailbox;

    constructor(address _mailbox) {
        require(Address.isContract(_mailbox), "!contract");
        mailbox = IMailbox(_mailbox);
    }

    // ============ Modifiers ============

    /**
     * @notice Only accept messages from an Hyperlane Mailbox contract
     */
    modifier onlyMailbox() {
        require(msg.sender == address(mailbox), "!mailbox");
        _;
    }
}
