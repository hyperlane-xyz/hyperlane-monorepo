// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {MailboxClient} from "contracts/client/MailboxClient.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";

/*
 * @title RateLimitedHook
 * @author Abacus Works
 * @notice A hook that rate limits the volume of token transfers to a destination using a bucket fill algorithm
 */
contract RateLimitedHook is
    AbstractPostDispatchHook,
    MailboxClient,
    RateLimited
{
    using Message for bytes;
    using TokenMessage for bytes;

    /// @notice The address that is authorized to call this hook
    address public immutable sender;
    /// @notice A mapping of message IDs to whether they have been validated
    mapping(bytes32 messageId => bool validated) public messageValidated;

    // ============ Modifiers ============

    /// @notice Ensures that the message has not been validated yet
    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        require(!messageValidated[messageId], "MessageAlreadyValidated");
        _;
        messageValidated[messageId] = true;
    }

    /// @notice Ensures that the message was sent by the authorized sender
    modifier onlySender(bytes calldata _message) {
        require(_message.senderAddress() == sender, "InvalidSender");
        _;
    }

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint256 _maxCapacity,
        address _sender
    ) MailboxClient(_mailbox) RateLimited(_maxCapacity) {
        require(_sender != address(0), "InvalidSender");
        sender = _sender;
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.RATE_LIMITED);
    }

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata,
        bytes calldata _message
    ) internal override onlySender(_message) validateMessageOnce(_message) {
        require(_isLatestDispatched(_message.id()), "InvalidDispatchedMessage");

        uint256 newAmount = _message.body().amount();
        _validateAndConsumeFilledLevel(newAmount);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }
}
