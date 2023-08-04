// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IMailbox} from "../interfaces/IMailbox.sol";
import {Message} from "../libs/Message.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

abstract contract MailboxClient {
    using Message for bytes;

    IMailbox immutable mailbox;

    constructor(address _mailbox) {
        require(Address.isContract(_mailbox), "MailboxClient: invalid mailbox");
        mailbox = IMailbox(_mailbox);
    }

    // ============ Modifiers ============

    /**
     * @notice Only accept messages from an Hyperlane Mailbox contract
     */
    modifier onlyMailbox() {
        require(
            msg.sender == address(mailbox),
            "MailboxClient: sender not mailbox"
        );
        _;
    }

    function isLatestDispatched(bytes32 id) internal view returns (bool) {
        return mailbox.latestDispatchedId() == id;
    }
}
