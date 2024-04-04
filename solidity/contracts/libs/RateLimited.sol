// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title RateLimited
 * @notice A contract used to keep track of an address sender's token amount limits.
 * @dev Implements a modified token bucket algorithm where the bucket is full in the beginning and gradually refills
 *
 **/
contract RateLimited is OwnableUpgradeable {
    uint256 public constant DURATION = 1 days; // 86400
    uint256 public filledLevel; /// @notice Current filled level
    uint256 public maxCapacity; /// @notice Max capacity where the bucket will no longer refill
    uint256 public refillRate; /// @notice Tokens per second refill rate
    uint256 public lastUpdated; /// @notice Timestamp of the last time an action has been taken TODO prob can be uint40

    event RateLimitSet(uint256 _oldCapacity, uint256 _newCapacity);

    constructor(uint256 _maxCapacity) {
        _transferOwnership(msg.sender);
        setMaxCapacity(_maxCapacity);
        filledLevel = _maxCapacity;
    }

    error RateLimitExceeded(uint256 newLimit, uint256 targetLimit);

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
    function calculateRefilledAmount() public view returns (uint256) {
        uint256 elapsed = block.timestamp - lastUpdated;
        return elapsed * refillRate;
    }

    /**
     * Calculates the adjusted fill level based on time
     */
    function calculateFilledLevel() public view returns (uint256) {
        uint256 _maxCapacity = maxCapacity;
        require(_maxCapacity > 0, "RateLimitNotSet");

        if (lastUpdated + DURATION > block.timestamp) {
            // If within the cycle, refill the capacity
            uint256 newCurrentCapcacity = filledLevel +
                calculateRefilledAmount();

            // Only return _maxCapacity, in the case where newCurrentCapcacity overflows
            return
                newCurrentCapcacity > _maxCapacity
                    ? _maxCapacity
                    : newCurrentCapcacity;
        } else {
            // If last update is in the previous cycle, return the max capacity
            return _maxCapacity;
        }
    }

    /**
     * Sets the max limit for a specific address
     * @param _maxCapacity new maxiumum limit to set
     */
    function setMaxCapacity(
        uint256 _maxCapacity
    ) public onlyOwner returns (uint256) {
        uint256 _oldCapacity = maxCapacity;
        maxCapacity = _maxCapacity;
        refillRate = _maxCapacity / DURATION;

        emit RateLimitSet(_oldCapacity, _maxCapacity);

        return _maxCapacity;
    }

    /**
     * Validate an amount and decreases the currentCapacity
     * @param _newAmount The amount to consume the fill level
     * @return The new filled level
     */
    function validateAndConsumeFilledLevel(
        uint256 _newAmount
    ) public returns (uint256) {
        uint256 adjustedFilledLevel = calculateFilledLevel();
        require(_newAmount <= adjustedFilledLevel, "RateLimitExceeded");

        // Reduce the filledLevel and update lastUpdated
        uint256 _filledLevel = adjustedFilledLevel - _newAmount;
        filledLevel = _filledLevel;
        lastUpdated = block.timestamp;

        return _filledLevel;
    }
}
