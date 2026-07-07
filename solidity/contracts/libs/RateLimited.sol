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
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title RateLimited
 * @notice A contract used to keep track of an address sender's token amount limits.
 * @dev Implements a modified token bucket algorithm where the bucket is full in the beginning and gradually refills
 * See: https://dev.to/satrobit/rate-limiting-using-the-token-bucket-algorithm-3cjh
 *
 */
contract RateLimited is OwnableUpgradeable {
    uint256 public constant DURATION = 1 days; // 86400
    /// @notice Current filled level
    uint256 public filledLevel;
    /// @notice Tokens per second refill rate
    uint256 public refillRate;
    /// @notice Timestamp of the last time an action has been taken
    uint256 public lastUpdated;

    event RateLimitSet(uint256 _oldCapacity, uint256 _newCapacity);

    event ConsumedFilledLevel(uint256 filledLevel, uint256 lastUpdated);
    event Credited(uint256 amount, uint256 newLevel);

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

    error RateLimitExceeded(uint256 newLimit, uint256 targetLimit);

    /**
     * @return The max capacity where the bucket will no longer refill
     */
    function maxCapacity() public view virtual returns (uint256) {
        return refillRate * DURATION;
    }

    /**
     * Calculates the refilled amount based on time and refill rate
     *
     * Consider an example where there is a 1e18 max token limit per day (86400s)
     * If half of the tokens has been used, and half a day (43200s) has passed,
     * then there should be a refill of 0.5e18
     *
     * To calculate:
     *   Refilled = Elapsed * RefilledRate
     *   Elapsed = timestamp - Limit.lastUpdated
     *   RefilledRate = Capacity / DURATION
     *
     *   If half of the day (43200) has passed, then
     *   (86400 - 43200) * (1e18 / 86400)  = 0.5e18
     */
    function calculateRefilledAmount() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastUpdated;
        return (elapsed * maxCapacity()) / DURATION;
    }

    /// @dev Whether the bucket has been set up and is metering flow. Base
    /// limiters bootstrap a full bucket in the constructor, so they are
    /// initialized from birth. Dynamic-capacity subclasses override this (and
    /// `_RateLimited_initialize`) to defer initialization until first use, so a
    /// limiter deployed before its pool is funded starts full at the live
    /// capacity instead of snapshotting a zero deploy-time capacity.
    function _RateLimited_isInitialized() internal view virtual returns (bool) {
        return true;
    }

    /// @dev Hook invoked by the consume/credit path to record first use.
    /// No-op for base limiters; overridden by subclasses that defer
    /// initialization (see `_RateLimited_isInitialized`).
    function _RateLimited_initialize() internal virtual {}

    /**
     * Calculates the adjusted fill level based on time
     */
    function calculateCurrentLevel() public view returns (uint256) {
        uint256 _capacity = maxCapacity();
        if (_capacity == 0) return 0;

        // Uninitialized buckets report full at the current capacity.
        if (!_RateLimited_isInitialized()) return _capacity;

        if (block.timestamp > lastUpdated + DURATION) {
            // If last update is in the previous window, return the max capacity
            return _capacity;
        } else {
            // If within the window, refill the capacity
            uint256 replenishedLevel = filledLevel + calculateRefilledAmount();

            // Only return _capacity, in the case where newCurrentCapacity overflows
            return replenishedLevel > _capacity ? _capacity : replenishedLevel;
        }
    }

    /**
     * Sets the refill rate by giving a capacity
     * @param _capacity new maximum capacity to set
     */
    function setRefillRate(
        uint256 _capacity
    ) public virtual onlyOwner returns (uint256) {
        uint256 _oldRefillRate = refillRate;
        uint256 _newRefillRate = _capacity / DURATION;
        refillRate = _newRefillRate;

        emit RateLimitSet(_oldRefillRate, _newRefillRate);

        return _newRefillRate;
    }

    /**
     * Validate an amount and decreases the currentCapacity
     * @param _consumedAmount The amount to consume the fill level
     * @return The new filled level
     */
    function _validateAndConsumeFilledLevel(
        uint256 _consumedAmount
    ) internal returns (uint256) {
        uint256 adjustedFilledLevel = calculateCurrentLevel();
        require(_consumedAmount <= adjustedFilledLevel, "RateLimitExceeded");

        // Reduce the filledLevel and update lastUpdated
        uint256 _filledLevel = adjustedFilledLevel - _consumedAmount;
        filledLevel = _filledLevel;
        lastUpdated = block.timestamp;
        _RateLimited_initialize();

        emit ConsumedFilledLevel(filledLevel, lastUpdated);

        return _filledLevel;
    }

    /**
     * Credit the bucket 1:1, clamped at maxCapacity.
     * No-op when capacity is zero.
     */
    function _credit(uint256 _amount) internal returns (uint256 newLevel) {
        uint256 cap = maxCapacity();
        if (cap == 0) return 0;
        uint256 credited = calculateCurrentLevel() + _amount;
        newLevel = credited > cap ? cap : credited;
        filledLevel = newLevel;
        lastUpdated = block.timestamp;
        _RateLimited_initialize();
        emit Credited(_amount, newLevel);
    }

    /**
     * Soft consume. Returns the seconds of refill needed to cover any
     * overage — callers treat it as a delay rather than a hard reject.
     * Returns type(uint256).max when capacity is zero.
     */
    function _consume(uint256 _amount) internal returns (uint256 deficitSecs) {
        uint256 cap = maxCapacity();
        uint256 level = calculateCurrentLevel();
        if (_amount <= level) {
            filledLevel = level - _amount;
        } else {
            filledLevel = 0;
            deficitSecs = cap == 0
                ? type(uint256).max
                : Math.mulDiv(_amount - level, DURATION, cap);
        }
        lastUpdated = block.timestamp;
        _RateLimited_initialize();
        emit ConsumedFilledLevel(filledLevel, lastUpdated);
    }
}
