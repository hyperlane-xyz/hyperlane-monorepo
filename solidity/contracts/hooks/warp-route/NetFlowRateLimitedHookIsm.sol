// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Message} from "../../libs/Message.sol";
import {NetFlowRateLimited} from "../../libs/NetFlowRateLimited.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";

/**
 * @title NetFlowRateLimitedHookIsm
 * @notice Hook + ISM pair that limits local collateral net outflow.
 * @dev Derives collateral/flow semantics from TokenRouter.token(). If
 * token() == router, outbound messages consume synthetic supply TVL. Otherwise,
 * inbound messages consume local collateral balance TVL.
 */
contract NetFlowRateLimitedHookIsm is
    AbstractPostDispatchHook,
    MailboxClient,
    NetFlowRateLimited,
    IInterchainSecurityModule
{
    enum FlowDirection {
        CREDIT,
        CONSUME
    }

    using Message for bytes;
    using TokenMessage for bytes;

    address public immutable router;
    uint32 public immutable minOutboundNonce;
    uint48 public immutable deployedAtBlock;
    FlowDirection public immutable outboundFlow;

    mapping(bytes32 messageId => bool validated) public messageValidated;

    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        require(!messageValidated[messageId], "MessageAlreadyValidated");
        messageValidated[messageId] = true;
        _;
    }

    modifier onlyRouterSender(bytes calldata _message) {
        require(_message.senderAddress() == router, "InvalidSender");
        _;
    }

    modifier onlyRouterRecipient(bytes calldata _message) {
        require(_message.recipientAddress() == router, "InvalidRecipient");
        _;
    }

    constructor(
        address _mailbox,
        address _router,
        uint256 _maxFlowBps
    ) MailboxClient(_mailbox) NetFlowRateLimited(_router, _maxFlowBps) {
        require(_router != address(0), "InvalidRouter");
        router = _router;
        minOutboundNonce = mailbox.nonce();
        deployedAtBlock = uint48(block.number);
        outboundFlow = token == _router
            ? FlowDirection.CONSUME
            : FlowDirection.CREDIT;
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.RATE_LIMITED);
    }

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.NULL);
    }

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata,
        bytes calldata _message
    )
        external
        onlyRouterRecipient(_message)
        validateMessageOnce(_message)
        returns (bool)
    {
        uint48 processedBlock = mailbox.processedAt(_message.id());
        // processedAt(id) == 0 means undelivered, so this also enforces delivery.
        require(processedBlock == block.number, "InvalidDeliveredMessage");

        uint256 amount = _message.body().amount();
        if (outboundFlow == FlowDirection.CREDIT) {
            _validateAndConsumeNetFlow(amount);
        } else {
            _creditNetFlow(amount);
        }

        return true;
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata,
        bytes calldata _message
    )
        internal
        override
        onlyRouterSender(_message)
        validateMessageOnce(_message)
    {
        require(_isLatestDispatched(_message.id()), "InvalidDispatchedMessage");
        require(
            _message.nonce() >= minOutboundNonce,
            "InvalidDispatchedMessage"
        );

        uint256 amount = _message.body().amount();
        if (outboundFlow == FlowDirection.CONSUME) {
            _validateAndConsumeNetFlow(amount);
        } else {
            _creditNetFlow(amount);
        }
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }
}
