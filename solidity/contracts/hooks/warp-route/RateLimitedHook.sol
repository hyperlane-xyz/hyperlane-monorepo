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

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    error InvalidDispatchedMessage();

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
        if (!_isLatestDispatched(_message.id()))
            revert InvalidDispatchedMessage();

        address sender = TypeCasts.bytes32ToAddress(_message.sender());
        uint256 newAmount = _message.body().amount();
        limits[sender].current = validateAndIncrementLimit(sender, newAmount);
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }
}
