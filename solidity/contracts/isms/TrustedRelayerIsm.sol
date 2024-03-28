// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {Message} from "../libs/Message.sol";

contract TrustedRelayerIsm is IInterchainSecurityModule, MailboxClient {
    using Message for bytes;

    uint8 public constant moduleType = uint8(Types.NULL);

    address public immutable trustedRelayer;

    constructor(
        address _mailbox,
        address _trustedRelayer
    ) MailboxClient(_mailbox) {
        trustedRelayer = _trustedRelayer;
    }

    function verify(
        bytes calldata,
        bytes calldata message
    ) external view returns (bool) {
        return mailbox.processor(message.id()) == trustedRelayer;
    }
}
