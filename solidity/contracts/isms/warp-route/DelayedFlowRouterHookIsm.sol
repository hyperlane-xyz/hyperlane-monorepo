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
import {TimelockRouter} from "../routing/TimelockRouter.sol";
import {TvlRateLimited} from "../../libs/TvlRateLimited.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";

/**
 * @title DelayedFlowRouterHookIsm
 * @notice Amount-sensitive extension of `TimelockRouter`: the `wait` for each
 * preverified message is derived from a token-bucket sized as a fraction of
 * the paired warp router's current balance or supply. Deposits credit the
 * bucket 1:1, preserving net-zero-flow UX for rebalancers while bounding
 * the blast radius of any ISM/bridge compromise.
 *
 * Cross-chain payload carries `(messageId, amount)` instead of just `id`.
 * `_handle` consumes the bucket (deducts `amount`, yielding a refill-time
 * deficit), clamps the result to `maxDelay`, and commits via the parent's
 * `_TimelockRouter_commitReadyAt`. Capacity is sized live from the paired
 * warp router's balance / supply — see `TvlRateLimited`.
 *
 * The refill window (`DURATION`) is set at construction so each deployment
 * can pick the cadence that suits its risk model.
 *
 * Compose with `PausableIsm` via `StaticAggregationIsm` so watchers can kill
 * delivery during the delay window.
 */
contract DelayedFlowRouterHookIsm is TimelockRouter, TvlRateLimited {
    using Message for bytes;
    using TokenMessage for bytes;

    // ============ Errors ============
    error WrongSender(address sender);
    error WrongRecipient(address recipient);
    error AlreadyCredited(uint32 nonce);

    // ============ Events ============
    /// @notice Emitted on the origin when `postDispatch` advances the credit
    /// nonce. Pairs with the destination-side `MessageQueued` for end-to-end
    /// observability of the rate-limit credit/consume flow.
    event NetFlowCredited(
        bytes32 indexed messageId,
        uint32 nonce,
        uint256 amount
    );

    // ============ Immutables ============

    /// @notice Cap on any single message's wait time. Watcher SLA and user
    /// worst-case UX bound.
    uint48 public immutable maxDelay;

    // ============ Storage ============

    /// @notice Highest Mailbox nonce for which the bucket has been credited.
    /// Combined with `TimelockRouter`'s `_isLatestDispatched` check, this
    /// single slot prevents same-message replay of the bucket credit.
    uint32 public lastCreditedNonce;

    // ============ Constructor ============

    constructor(
        TokenRouter _warpRouter,
        uint256 _thresholdBps,
        uint48 _maxDelay,
        uint256 _refillWindow
    )
        TimelockRouter(address(_warpRouter.mailbox()), 0)
        // capacity derived dynamically; storage refillRate unused
        TvlRateLimited(_warpRouter, _thresholdBps, _refillWindow)
    {
        maxDelay = _maxDelay;
    }

    /// @dev Delay-mode override: a 100% threshold is permitted. Over-limit
    /// messages are delayed (capped at `maxDelay`), not reverted, so the
    /// synthetic post-burn discontinuity that bars 100% for reject-mode
    /// limiters does not apply here.
    function _validateThresholdBps(
        uint256 _thresholdBps
    ) internal view override {
        if (_thresholdBps > BPS_DENOMINATOR) revert InvalidThresholdBps();
    }

    // ============ TimelockRouter overrides ============

    /// @dev Origin-side side effects for `postDispatch`. Sender binding
    /// prevents an attacker from dispatching an arbitrary message through the
    /// Mailbox and triggering a credit + preverify against our paired pool's
    /// bucket; the nonce guard is a one-shot replay guard for the credit.
    function _TimelockRouter_onDispatch(
        bytes calldata message
    ) internal override {
        if (message.senderAddress() != warpRouter) {
            revert WrongSender(message.senderAddress());
        }

        uint32 messageNonce = message.nonce();
        if (messageNonce <= lastCreditedNonce) {
            revert AlreadyCredited(messageNonce);
        }
        lastCreditedNonce = messageNonce;

        // `TokenMessage` slices `body[32:64]` for `amount`. Safe here: the
        // parent asserted `_isLatestDispatched` before invoking this hook, and
        // the sender binding above only passes for messages formatted by
        // `warpRouter`, which only ever formats valid token messages. Metered
        // in this router's local units (converted from the message amount).
        uint256 amount = _toLocalAmount(message.body().amount());
        bytes32 messageId = message.id();
        _credit(amount);
        emit NetFlowCredited(messageId, messageNonce, amount);
    }

    /// @dev Carries `(id, messageAmount)` so the destination can size the delay
    /// against its current bucket. The message amount is carried as-is and
    /// converted to local units on each side (`_toLocalAmount`), so origin
    /// and destination each meter using their own router's scale. Shared by
    /// `postDispatch` and `quoteDispatch` via the parent, so the quote can
    /// never drift from the dispatched payload.
    function _encodePayload(
        bytes calldata message
    ) internal view override returns (bytes memory) {
        return abi.encode(message.id(), message.body().amount());
    }

    /// @dev Recipient binding prevents verifying messages that aren't
    /// destined for our paired warp router (e.g. a third-party contract
    /// that configured us as its ISM).
    function _TimelockRouter_verify(
        bytes calldata message
    ) internal view override returns (bool) {
        if (message.recipientAddress() != warpRouter) {
            revert WrongRecipient(message.recipientAddress());
        }

        return super._TimelockRouter_verify(message);
    }

    /// @dev Consume the bucket, cap at `maxDelay`, then commit `readyAt`.
    /// All the rate-limit math lives in `RateLimited._consume`; this only
    /// adds the cap. The amount is cryptographically bound to the message
    /// id via `keccak256(fullMessage)`, so no explicit amount-match check
    /// is required at verify time.
    function _handle(
        uint32 /*_origin*/,
        bytes32 /*_sender*/,
        bytes calldata payload
    ) internal override {
        (bytes32 id, uint256 messageAmount) = abi.decode(
            payload,
            (bytes32, uint256)
        );
        uint256 deficitSecs = _consume(_toLocalAmount(messageAmount));
        uint48 wait = deficitSecs > maxDelay ? maxDelay : uint48(deficitSecs);
        _TimelockRouter_commitReadyAt(id, wait);
    }
}
