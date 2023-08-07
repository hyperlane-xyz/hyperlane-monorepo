// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "forge-std/console.sol";

// ============ Internal Imports ============
import {IMailbox} from "../interfaces/IMailbox.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

abstract contract MailboxClient {
    /// @notice keeping mailbox immutable for maintaining sync
    IMailbox immutable mailbox;
    /// @notice default hook for authorizing dispatch hook calls
    address public defaultHook;

    constructor(address _mailbox) {
        require(Address.isContract(_mailbox), "!contract");
        mailbox = IMailbox(_mailbox);
        defaultHook = address(mailbox.defaultHook());
    }

    // ============ Modifiers ============

    /**
     * @notice Only accept messages from the Default Hook contract.
     */
    modifier authorized() {
        require(
            msg.sender == address(mailbox) ||
                msg.sender == address(defaultHook),
            "!authorized"
        );
        _;
    }

    function updateDefaultHook() external {
        defaultHook = address(mailbox.defaultHook());
    }
}
