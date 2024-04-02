// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMailbox} from "contracts/interfaces/IMailbox.sol";
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";

contract RateLimitedIsm is RateLimited, IInterchainSecurityModule {
    using Message for bytes;
    using TokenMessage for bytes;

    IMailbox mailbox;

    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    error InvalidDeliveredMessage();

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external view returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.UNUSED);
    }

    /**
     * Verify a message, rate limit, and increment the sender's limit.
     */
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external returns (bool) {
        if (!_isLatestDelivered(_message.id()))
            revert InvalidDeliveredMessage();

        address sender = TypeCasts.bytes32ToAddress(_message.sender());
        uint256 newAmount = _message.body().amount();
        limits[sender].current = validateAndIncrementLimit(sender, newAmount);

        return true;
    }

    function _isLatestDelivered(bytes32 id) internal view returns (bool) {
        return mailbox.delivered(id);
    }
}
