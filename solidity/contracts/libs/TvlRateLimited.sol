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

    // ============ Constructor ============

    constructor(TokenRouter _warpRouter, uint256 _thresholdBps) RateLimited(0) {
        if (address(_warpRouter) == address(0)) revert InvalidRouter();
        if (_thresholdBps >= BPS_DENOMINATOR) revert InvalidThresholdBps();

        warpRouter = address(_warpRouter);
        capacityToken = _warpRouter.token();
        thresholdBps = _thresholdBps;
        // The bucket starts full at the current capacity on first use (see
        // `RateLimited.isInitialized`), so no deploy-time bootstrap is needed —
        // capacity is derived live from `warpRouter`'s balance / supply.
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

    /// @inheritdoc RateLimited
    /// @dev `refillRate` is dead storage here; capacity derives from
    /// `warpRouter`'s TVL. Reverting prevents an owner from quietly writing a
    /// slot the rate-limit math never reads.
    function setRefillRate(
        uint256 /*_capacity*/
    ) public override onlyOwner returns (uint256) {
        revert UseThresholdBps();
    }
}
