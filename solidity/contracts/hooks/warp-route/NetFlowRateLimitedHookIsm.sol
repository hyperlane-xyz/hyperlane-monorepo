// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Message} from "../../libs/Message.sol";
import {TvlRateLimited} from "../../libs/TvlRateLimited.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";

/**
 * @title NetFlowRateLimitedHookIsm
 * @notice Hook + ISM pair that caps a warp router's net collateral outflow per
 * `DURATION` window.
 * @dev Mechanic: the same contract is installed as both the router's hook and
 * its ISM. Outbound dispatches run through `_postDispatch`, inbound deliveries
 * through `verify()`. Each direction either consumes or credits a token bucket
 * sized at `thresholdBps` of live TVL (see `TvlRateLimited`), so only the
 * *net* amount leaving the router is rate limited — symmetric flow nets out.
 * The consume/credit direction is derived from `TokenRouter.token()`: if
 * `token() == router` the route is synthetic (outbound burns supply → consume
 * on dispatch); otherwise it is collateral (outbound moves balance out →
 * consume on deliver).
 *
 * @dev Use only for routes where `token()`'s balance at the router is the live
 * TVL AND the message<->local conversion is `TokenRouter`'s fixed `scale`
 * (what `_toLocalAmount` reproduces to meter the message amount in local
 * units): HypERC20, HypERC20Collateral, HypNative. Do NOT use for:
 *   - HypXERC20 / HypXERC20Lockbox / HypFiatToken / HypERC4626Collateral —
 *     `token()`'s `balanceOf(router) == 0` (they mint/burn an external token or
 *     hold vault shares), so capacity collapses to zero and the route bricks.
 *   - HypERC4626 (synthetic, rebasing) — `token() == router` gives a *nonzero*
 *     capacity (so the zero-capacity check above does NOT catch it), but it
 *     scales by exchange rate rather than the fixed `scale` fraction, so
 *     `_toLocalAmount` meters the wrong units (message shares vs
 *     asset-denominated TVL).
 *
 * @dev This contract authenticates flow only, NOT message authenticity
 * (`moduleType()` is NULL). Deployers MUST compose it under an authenticating
 * ISM (e.g. AggregationIsm with a MultisigIsm); using it as a route's sole ISM
 * lets any caller process a forged message subject only to bucket capacity.
 */
contract NetFlowRateLimitedHookIsm is
    AbstractPostDispatchHook,
    MailboxClient,
    TvlRateLimited,
    IInterchainSecurityModule
{
    enum FlowDirection {
        CREDIT,
        CONSUME
    }

    using Message for bytes;
    using TokenMessage for bytes;

    /// @notice Mailbox nonce at deploy time. Outbound messages with a lower
    /// nonce predate this hook, were never metered, and are rejected by
    /// `_postDispatch` so already-dispatched history cannot be replayed through
    /// the hook to drain the bucket.
    uint32 public immutable minOutboundNonce;
    /// @notice Block this contract was deployed at.
    uint48 public immutable deployedAtBlock;
    /// @notice Whether an outbound dispatch consumes or credits the bucket.
    /// CONSUME for synthetic routes (outbound burns supply), CREDIT for
    /// collateral routes (outbound is metered on inbound delivery instead).
    FlowDirection public immutable outboundFlow;

    mapping(bytes32 messageId => bool validated) public messageValidated;

    /// @notice Emitted when `messageId` is first observed (either via `verify`
    /// or `_postDispatch`). Provides an event trail for replay-bit transitions.
    event MessageValidated(bytes32 indexed messageId);

    error WrongSender(address sender);
    error WrongRecipient(address recipient);
    error MessageAlreadyValidated(bytes32 messageId);
    error InvalidDeliveredMessage(bytes32 messageId);
    error InvalidDispatchedMessage(bytes32 messageId);

    modifier validateMessageOnce(bytes calldata _message) {
        bytes32 messageId = _message.id();
        if (messageValidated[messageId]) {
            revert MessageAlreadyValidated(messageId);
        }
        messageValidated[messageId] = true;
        emit MessageValidated(messageId);
        _;
    }

    modifier onlyRouterSender(bytes calldata _message) {
        if (_message.senderAddress() != warpRouter) {
            revert WrongSender(_message.senderAddress());
        }
        _;
    }

    modifier onlyRouterRecipient(bytes calldata _message) {
        if (_message.recipientAddress() != warpRouter) {
            revert WrongRecipient(_message.recipientAddress());
        }
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
    )
        MailboxClient(_mailbox)
        TvlRateLimited(TokenRouter(_router), _maxFlowBps)
    {
        // _router != address(0) is enforced by TvlRateLimited's constructor.
        minOutboundNonce = mailbox.nonce();
        deployedAtBlock = uint48(block.number);
        outboundFlow = capacityToken == _router
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
    /// @dev Binds consumption to the message being delivered by `Mailbox`
    ///      *in this transaction* via `_isProcessing` — callers cannot invoke
    ///      `verify()` directly to move the bucket. (This is flow binding, NOT
    ///      authentication — see the contract-level docstring on composition
    ///      with an authenticating ISM.)
    function verify(
        bytes calldata,
        bytes calldata _message
    )
        external
        onlyRouterRecipient(_message)
        validateMessageOnce(_message)
        returns (bool)
    {
        if (!_isProcessing(_message.id())) {
            revert InvalidDeliveredMessage(_message.id());
        }

        uint256 amount = _toLocalAmount(_message.body().amount());
        if (outboundFlow == FlowDirection.CREDIT) {
            _validateAndConsumeFilledLevel(amount);
        } else {
            _credit(amount);
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
        bytes32 messageId = _message.id();
        if (!_isLatestDispatched(messageId)) {
            revert InvalidDispatchedMessage(messageId);
        }
        if (_message.nonce() < minOutboundNonce) {
            revert InvalidDispatchedMessage(messageId);
        }

        uint256 amount = _toLocalAmount(_message.body().amount());
        if (outboundFlow == FlowDirection.CONSUME) {
            _validateAndConsumeFilledLevel(amount);
        } else {
            _credit(amount);
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
