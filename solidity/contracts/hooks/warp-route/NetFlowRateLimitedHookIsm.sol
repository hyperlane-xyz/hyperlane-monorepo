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

    /// @notice Emitted when `messageId` is first observed (either via `verify`
    /// or `_postDispatch`). Provides an event trail for replay-bit transitions.
    event MessageValidated(bytes32 indexed messageId);

    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        require(!messageValidated[messageId], "MessageAlreadyValidated");
        messageValidated[messageId] = true;
        emit MessageValidated(messageId);
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

    /// @param _mailbox Local mailbox address. Used to read `processedAt` for
    ///        inbound replay protection and `nonce` for the outbound nonce
    ///        floor (`minOutboundNonce`).
    /// @param _router The local warp router this hook/ISM guards. Must be the
    ///        same router that has this contract installed as its hook AND ISM.
    /// @param _maxFlowBps Net outflow allowed per `DURATION` window, expressed
    ///        as basis points of the live TVL. Strictly less than 10_000.
    constructor(
        address _mailbox,
        address _router,
        uint256 _maxFlowBps
    ) MailboxClient(_mailbox) NetFlowRateLimited(_router, _maxFlowBps) {
        // _router != address(0) is enforced by NetFlowRateLimited's constructor.
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
    /// @dev `processedAt(id) == block.number` confirms that `Mailbox.process()`
    ///      is the active caller (it writes `deliveries[id].blockNumber` just
    ///      before invoking `ism.verify(...)` — see `Mailbox.sol::process`).
    ///      This binds the rate-limit consumption to the message being processed
    ///      *in this same transaction* and prevents callers from invoking
    ///      `verify()` directly to consume the bucket without going through the
    ///      mailbox. (Note: this is NOT authentication — see contract-level
    ///      docstring on composition with an authenticating ISM.)
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
