// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMailbox} from "contracts/interfaces/IMailbox.sol";
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";

contract RateLimitedIsm is
    RateLimited,
    MailboxClient,
    IInterchainSecurityModule
{
    using Message for bytes;
    using TokenMessage for bytes;
    using TypeCasts for bytes32;

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.UNUSED);
    }

    /**
     * Verify a message, rate limit, and increment the sender's limit.
     * @dev ensures that this gets called by the Mailbox
     */
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external onlyMailbox returns (bool) {
        require(_isLatestDelivered(_message.id()), "InvalidDeliveredMessage");

        address sender = (_message.sender().bytes32ToAddress());
        uint256 newAmount = _message.body().amount();
        validateAndIncrementLimit(sender, newAmount);

        return true;
    }
}
