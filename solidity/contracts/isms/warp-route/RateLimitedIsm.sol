// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";

contract RateLimitedIsm is
    MailboxClient,
    RateLimited,
    IInterchainSecurityModule
{
    using Message for bytes;
    using TokenMessage for bytes;

    address public immutable recipient;

    mapping(bytes32 messageId => bool validated) public messageValidated;

    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        require(!messageValidated[messageId], "MessageAlreadyValidated");
        messageValidated[messageId] = true;
        _;
    }

    modifier onlyRecipient(bytes calldata _message) {
        require(_message.recipientAddress() == recipient, "InvalidRecipient");
        _;
    }

    constructor(
        address _mailbox,
        uint256 _maxCapacity,
        address _recipient
    ) MailboxClient(_mailbox) RateLimited(_maxCapacity) {
        recipient = _recipient;
    }

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /**
     * Verify a message, rate limit, and increment the sender's limit.
     * @dev ensures that this gets called by the Mailbox
     */
    function verify(
        bytes calldata,
        bytes calldata _message
    )
        external
        onlyRecipient(_message)
        validateMessageOnce(_message)
        returns (bool)
    {
        require(_isDelivered(_message.id()), "InvalidDeliveredMessage");

        uint256 newAmount = _message.body().amount();
        _validateAndConsumeFilledLevel(newAmount);

        return true;
    }
}
