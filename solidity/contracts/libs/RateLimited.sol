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

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title RateLimited
 * @notice Token-bucket rate limiter: the bucket refills to `maxCapacity`
 * linearly over `DURATION`. `maxCapacity` is virtual so subclasses may
 * derive it from external state (e.g. a paired token balance); the
 * refill rate always follows from it.
 * @dev See https://dev.to/satrobit/rate-limiting-using-the-token-bucket-algorithm-3cjh
 */
contract RateLimited is OwnableUpgradeable {
    uint256 public constant DURATION = 1 days;

    /// @notice Current filled level.
    uint256 public filledLevel;

    /// @notice Default-mode tokens-per-second refill rate. Unused by
    /// subclasses that override `maxCapacity()`.
    uint256 public refillRate;

    /// @notice Timestamp of the last mutation.
    uint256 public lastUpdated;

    event RateLimitSet(uint256 oldRefillRate, uint256 newRefillRate);
    event ConsumedFilledLevel(uint256 filledLevel, uint256 lastUpdated);
    event Credited(uint256 amount, uint256 newLevel);

    error RateLimitExceeded(uint256 newLimit, uint256 targetLimit);

    constructor(uint256 _capacity) {
        // `_capacity == 0` is permitted for subclasses with a dynamic cap.
        require(
            _capacity == 0 || _capacity >= DURATION,
            "Capacity must be greater than DURATION"
        );
        _transferOwnership(msg.sender);
        if (_capacity > 0) {
            setRefillRate(_capacity);
            filledLevel = _capacity;
        }
        lastUpdated = block.timestamp;
    }

    // ============ Views ============

    /// @notice Max bucket capacity. Override to back with dynamic state.
    function maxCapacity() public view virtual returns (uint256) {
        return refillRate * DURATION;
    }

    /// @notice Time-adjusted fill level, clamped to `maxCapacity`.
    function calculateCurrentLevel() public view returns (uint256) {
        return _levelAt(maxCapacity());
    }

    // ============ Owner admin ============

    /// @notice Sets `refillRate = _capacity / DURATION`.
    function setRefillRate(
        uint256 _capacity
    ) public onlyOwner returns (uint256 newRate) {
        uint256 oldRate = refillRate;
        newRate = _capacity / DURATION;
        refillRate = newRate;
        emit RateLimitSet(oldRate, newRate);
    }

    // ============ Internal helpers ============

    /// @notice Hard-cap consume. Reverts with `RateLimitExceeded` on overage.
    function _validateAndConsumeFilledLevel(
        uint256 _amount
    ) internal returns (uint256) {
        uint256 cap = maxCapacity();
        uint256 level = _levelAt(cap);
        require(_amount <= level, "RateLimitExceeded");
        _writeConsume(_amount, level, cap);
        return filledLevel;
    }

    /// @notice Credit the bucket 1:1, clamped at `maxCapacity`. No-op when
    /// capacity is zero.
    function _credit(uint256 _amount) internal returns (uint256 newLevel) {
        uint256 cap = maxCapacity();
        if (cap == 0) return 0;
        uint256 credited = _levelAt(cap) + _amount;
        newLevel = credited > cap ? cap : credited;
        filledLevel = newLevel;
        lastUpdated = block.timestamp;
        emit Credited(_amount, newLevel);
    }

    /// @notice Soft consume. Returns the seconds of refill needed to cover
    /// any overage — callers treat it as a delay rather than a hard reject.
    /// Returns `type(uint256).max` when capacity is zero.
    function _consume(uint256 _amount) internal returns (uint256) {
        uint256 cap = maxCapacity();
        return _writeConsume(_amount, _levelAt(cap), cap);
    }

    // ============ Private core ============

    /// @dev Level at a caller-supplied cap so mutation paths don't re-read
    /// `maxCapacity()`.
    function _levelAt(uint256 _cap) private view returns (uint256) {
        if (_cap == 0) return 0;
        uint256 elapsed = block.timestamp - lastUpdated;
        uint256 replenished = filledLevel +
            Math.mulDiv(elapsed, _cap, DURATION);
        return replenished > _cap ? _cap : replenished;
    }

    /// @dev Shared bucket mutation for `_consume` / `_validateAndConsume…`.
    function _writeConsume(
        uint256 _amount,
        uint256 _level,
        uint256 _cap
    ) private returns (uint256 deficitSecs) {
        if (_amount <= _level) {
            filledLevel = _level - _amount;
        } else {
            filledLevel = 0;
            deficitSecs = _cap == 0
                ? type(uint256).max
                : Math.mulDiv(_amount - _level, DURATION, _cap);
        }
        lastUpdated = block.timestamp;
        emit ConsumedFilledLevel(filledLevel, lastUpdated);
    }
}
