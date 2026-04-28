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

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ============ Internal Imports ============
import {TimelockRouter} from "../routing/TimelockRouter.sol";
import {RateLimited} from "../../libs/RateLimited.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";

/**
 * @title DelayedFlowRouter
 * @notice Amount-sensitive extension of `TimelockRouter`: the `wait` for each
 * preverified message is derived from a token-bucket sized as a fraction of
 * the paired warp router's current balance or supply. Deposits credit the
 * bucket 1:1, preserving net-zero-flow UX for rebalancers while bounding
 * the blast radius of any ISM/bridge compromise.
 *
 * Cross-chain payload carries `(messageId, amount)` instead of just `id`.
 * `_handle` consumes the bucket (deducts `amount`, yielding a refill-time
 * deficit), clamps the result to `maxDelay`, and commits via the parent's
 * `_TimelockRouter_commitReadyAt`.
 *
 * Capacity base is derived from `warpRouter.token()`:
 *   - `token() == 0`            → native balance (HypNative)
 *   - `token() == warpRouter`   → synthetic totalSupply (HypERC20)
 *   - otherwise                  → underlying ERC20 balance (HypERC20Collateral)
 *
 * Compose with `PausableIsm` via `StaticAggregationIsm` so watchers can kill
 * delivery during the delay window.
 */
contract DelayedFlowRouter is TimelockRouter, RateLimited {
    using Message for bytes;
    using TokenMessage for bytes;

    // ============ Immutables ============

    /// @notice Paired warp router on this chain. Used to read the capacity
    /// base and as the `_isLatestDispatched` anchor.
    address public immutable warpRouter;

    /// @notice Capacity source, encoded by address:
    ///   - `address(0)`           → native balance of `warpRouter`
    ///   - `address(warpRouter)`  → `totalSupply()` of the synthetic token
    ///   - any other ERC20        → `balanceOf(warpRouter)` of that token
    address public immutable capacityToken;

    /// @notice Fraction of the capacity base (bps) used to size `maxCapacity`.
    uint256 public immutable thresholdBps;

    /// @notice Cap on any single message's wait time. Watcher SLA and user
    /// worst-case UX bound.
    uint48 public immutable maxDelay;

    uint256 internal constant _BPS = 10_000;

    // ============ Storage ============

    /// @notice Highest Mailbox nonce for which the bucket has been credited.
    /// Combined with `TimelockRouter`'s `_isLatestDispatched` check, this
    /// single slot prevents same-message replay of the bucket credit.
    uint32 public lastCreditedNonce;

    // ============ Constructor ============

    constructor(
        TokenRouter _warpRouter,
        uint256 _thresholdBps,
        uint48 _maxDelay
    )
        TimelockRouter(address(_warpRouter.mailbox()), 0)
        RateLimited(0) // capacity derived dynamically; storage refillRate unused
    {
        require(_thresholdBps <= _BPS, "thresholdBps > 100%");
        warpRouter = address(_warpRouter);
        capacityToken = _warpRouter.token();
        thresholdBps = _thresholdBps;
        maxDelay = _maxDelay;

        // Bootstrap the bucket at current max capacity so a freshly-deployed
        // router doesn't delay the first legitimate withdrawal. The pool is
        // funded before deployment; subsequent balance changes are picked up
        // dynamically by `maxCapacity()`. `lastUpdated` is already set by
        // `RateLimited`'s constructor.
        filledLevel = maxCapacity();
    }

    // ============ Capacity ============

    /// @inheritdoc RateLimited
    /// @dev Sole capacity definition for the router. Read at call time (not
    /// snapshotted) so the cap tracks the paired pool's current balance /
    /// supply. `RateLimited.calculateRefilledAmount` derives the refill
    /// rate from this, so no additional override is needed.
    function maxCapacity() public view override returns (uint256) {
        uint256 base;
        if (capacityToken == address(0)) {
            base = warpRouter.balance;
        } else if (capacityToken == warpRouter) {
            base = IERC20(capacityToken).totalSupply();
        } else {
            base = IERC20(capacityToken).balanceOf(warpRouter);
        }
        return (base * thresholdBps) / _BPS;
    }

    // ============ TimelockRouter overrides ============

    /// @dev One-shot replay guard, bucket credit, then a single call into
    /// the parent's leaf dispatch helper. Payload carries `(id, amount)` so
    /// the destination can size the delay against its current bucket.
    /// Sender binding prevents an attacker from dispatching an arbitrary
    /// message through the Mailbox and triggering a credit + preverify
    /// against our paired pool's bucket.
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable override {
        require(
            message.senderAddress() == warpRouter,
            "DelayedFlowRouter: wrong sender"
        );
        uint32 n = message.nonce();
        require(n > lastCreditedNonce, "DelayedFlowRouter: already credited");
        lastCreditedNonce = n;

        uint256 amount = message.body().amount();
        _credit(amount);

        bytes32 id = message.id();
        _TimelockRouter_dispatchPreverify(
            id,
            message.destination(),
            abi.encode(id, amount)
        );
    }

    /// @dev Recipient binding prevents verifying messages that aren't
    /// destined for our paired warp router (e.g. a third-party contract
    /// that configured us as its ISM).
    function verify(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external view override returns (bool) {
        require(
            message.recipientAddress() == warpRouter,
            "DelayedFlowRouter: wrong recipient"
        );
        return _TimelockRouter_verify(message);
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
        (bytes32 id, uint256 amount) = abi.decode(payload, (bytes32, uint256));
        uint256 deficitSecs = _consume(amount);
        uint48 wait = deficitSecs > maxDelay ? maxDelay : uint48(deficitSecs);
        _TimelockRouter_commitReadyAt(id, wait);
    }
}
