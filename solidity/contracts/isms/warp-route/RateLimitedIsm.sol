// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMailbox} from "contracts/interfaces/IMailbox.sol";
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";

contract RateLimitedIsm is
    MailboxClient,
    RateLimited,
    IInterchainSecurityModule
{
    using Message for bytes;
    using TokenMessage for bytes;

    mapping(bytes32 messageId => bool validated) public messageValidated;

    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        require(!messageValidated[messageId], "MessageAlreadyValidated");
        messageValidated[messageId] = true;
        _;
    }

    constructor(
        address _mailbox,
        uint256 _maxCapacity
    ) MailboxClient(_mailbox) RateLimited(_maxCapacity) {}

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
    ) external validateMessageOnce(_message) returns (bool) {
        require(_isDelivered(_message.id()), "InvalidDeliveredMessage");

        uint256 newAmount = _message.body().amount();
        validateAndConsumeFilledLevel(newAmount);

        return true;
    }
}
