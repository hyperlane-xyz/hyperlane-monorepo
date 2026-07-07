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
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// ============ Internal Imports ============
import {RateLimited} from "./RateLimited.sol";
import {TokenRouter} from "../token/libs/TokenRouter.sol";

/**
 * @title TvlRateLimited
 * @notice `RateLimited` whose capacity is a live fraction (bps) of a paired
 * warp router's TVL, instead of a static owner-set refill rate.
 *
 * @dev The capacity base is derived from `warpRouter.token()`:
 *   - `token() == address(0)`  → native balance (HypNative)
 *   - `token() == warpRouter`  → synthetic `totalSupply()` (HypERC20)
 *   - otherwise                → underlying `balanceOf(warpRouter)` (HypERC20Collateral)
 *
 * The base is read live at call time, so direct transfers to `warpRouter`
 * (or `selfdestruct` for HypNative) inflate it. This is by design — growing
 * the balance to raise the cap also funds the pool the cap is gating, so an
 * attacker pays for any drain-headroom they unlock.
 *
 * @dev TVL is assumed to change only via Hyperlane operations (inbound process
 * / outbound dispatch), each of which touches the bucket. Under this assumption
 * `maxCapacity()` is constant between touches, so `calculateCurrentLevel`'s
 * time-based replenishment never mixes two capacity epochs. Donations only grow
 * TVL, never shrink it, so the level clamp is defensive — it only fires under
 * externally-driven shrinks, which are out of scope for warp routes.
 */
abstract contract TvlRateLimited is RateLimited {
    using StorageSlot for bytes32;
    using Math for uint256;

    // ============ Errors ============
    error InvalidRouter();
    error InvalidThresholdBps();
    /// @dev Inherited `RateLimited.setRefillRate` writes a dead storage slot
    ///      here (capacity derives from `maxCapacity()`, not `refillRate`).
    ///      Reverting prevents an operator foot-gun where the tx succeeds but
    ///      the rate is unchanged.
    error UseThresholdBps();

    // ============ Immutables ============

    /// @notice Paired warp router whose TVL sizes the capacity.
    address public immutable warpRouter;

    /// @notice Capacity source, encoded by address:
    ///   - `address(0)`           → native balance of `warpRouter`
    ///   - `address(warpRouter)`  → `totalSupply()` of the synthetic token
    ///   - any other ERC20        → `balanceOf(warpRouter)` of that token
    address public immutable capacityToken;

    /// @notice Fraction of the TVL base (bps) used to size `maxCapacity`.
    uint256 public immutable thresholdBps;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Persistent "has the bucket been used yet" flag. Kept in a hashed
    /// slot rather than a contiguous state variable so this base can be mixed
    /// into contracts without shifting their storage layout.
    bytes32 private constant IS_INITIALIZED_SLOT =
        keccak256("hyperlane.storage.TvlRateLimited.isInitialized");

    // ============ Constructor ============

    constructor(TokenRouter _warpRouter, uint256 _thresholdBps) RateLimited(0) {
        if (address(_warpRouter) == address(0)) revert InvalidRouter();
        _validateThresholdBps(_thresholdBps);

        warpRouter = address(_warpRouter);
        capacityToken = _warpRouter.token();
        thresholdBps = _thresholdBps;
        // The bucket starts full at the current capacity on first use (see
        // `_RateLimited_isInitialized`), so no deploy-time bootstrap is needed
        // — capacity is derived live from `warpRouter`'s balance / supply.
    }

    /// @dev Validates the configured threshold at construction. Default: strictly
    /// below 100% — for reject-mode limiters a 100% cap is degenerate (in the
    /// synthetic-outbound case the router burns supply before metering, so
    /// `totalSupply()` and thus capacity collapse below the amount, gating the
    /// dispatch with no usable headroom). Delay-mode subclasses may relax this.
    function _validateThresholdBps(
        uint256 _thresholdBps
    ) internal view virtual {
        if (_thresholdBps >= BPS_DENOMINATOR) revert InvalidThresholdBps();
    }

    // ============ Capacity ============

    /// @notice TVL base used to size capacity, before applying `thresholdBps`.
    function localCollateral() public view returns (uint256) {
        if (capacityToken == address(0)) {
            return warpRouter.balance;
        }
        if (capacityToken == warpRouter) {
            return IERC20(capacityToken).totalSupply();
        }
        return IERC20(capacityToken).balanceOf(warpRouter);
    }

    /// @inheritdoc RateLimited
    /// @dev Read at call time (not snapshotted) so the cap tracks the paired
    /// pool's current balance / supply. `RateLimited.calculateRefilledAmount`
    /// derives the refill rate from this, so no additional override is needed.
    function maxCapacity() public view override returns (uint256) {
        return (localCollateral() * thresholdBps) / BPS_DENOMINATOR;
    }

    /// @notice Converts a message amount to local token units so it is
    /// commensurate with the bucket, which is denominated in `localCollateral()`
    /// units.
    /// @dev Mirrors `TokenRouter._inboundAmount` for fixed-scale routes (the
    /// only supported ones) — same `mulDiv` and rounding — so the metered
    /// amount matches the collateral the router actually moves.
    function _toLocalAmount(
        uint256 _messageAmount
    ) internal view returns (uint256) {
        TokenRouter router = TokenRouter(warpRouter);
        return
            _messageAmount.mulDiv(
                router.scaleDenominator(),
                router.scaleNumerator(),
                Math.Rounding.Down
            );
    }

    /// @inheritdoc RateLimited
    /// @dev `refillRate` is dead storage here; capacity derives from
    /// `warpRouter`'s TVL. Reverting prevents an owner from quietly writing a
    /// slot the rate-limit math never reads.
    function setRefillRate(
        uint256 /*_capacity*/
    ) public override onlyOwner returns (uint256) {
        revert UseThresholdBps();
    }

    // ============ Initialization ============

    /// @inheritdoc RateLimited
    /// @dev Initialization is deferred to first use and recorded in the hashed
    /// `IS_INITIALIZED_SLOT`, so the bucket reports full at the live capacity
    /// until then.
    function _RateLimited_isInitialized()
        internal
        view
        override
        returns (bool)
    {
        return IS_INITIALIZED_SLOT.getBooleanSlot().value;
    }

    /// @inheritdoc RateLimited
    function _RateLimited_initialize() internal override {
        IS_INITIALIZED_SLOT.getBooleanSlot().value = true;
    }
}
