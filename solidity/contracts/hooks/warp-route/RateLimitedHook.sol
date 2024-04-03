// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";

contract RateLimitedHook is IPostDispatchHook, RateLimited, MailboxClient {
    using Message for bytes;
    using TokenMessage for bytes;
    using TypeCasts for bytes32;

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.UNUSED);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return false;
    }

    /**
     * Verify a message, rate limit, and increment the sender's limit.
     * @dev ensures that this gets called by the Mailbox
     */
    function postDispatch(
        bytes calldata,
        bytes calldata _message
    ) external payable {
        require(_isLatestDispatched(_message.id()), "InvalidDispatchedMessage");

        address sender = _message.sender().bytes32ToAddress();
        uint256 newAmount = _message.body().amount();
        validateAndIncrementLimit(sender, newAmount);
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }
}
