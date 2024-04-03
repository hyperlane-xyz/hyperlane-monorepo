// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title RateLimited
 * @notice A contract used to keep track of an address sender's token amount limits
 **/
contract RateLimited is OwnableUpgradeable {
    uint256 public constant DURATION = 1 days; // 86400

    mapping(address sender => Limit limit) public limits;

    event RateLimitSet(address sender, uint256 amount);
    error RateLimitNotSet(address sender);

    constructor() {
        _transferOwnership(msg.sender);
    }

    struct Limit {
        uint256 lastUpdate; /// @notice Timestamp of the last time an action has been taken
        uint256 tokenPerSecond; /// @notice Allowed tokens per second
        uint256 current; /// @notice Limit amount used
        uint256 max; /// @notice Maximum token amount
    }

    error RateLimitExceeded(uint256 newLimit, uint256 targetLimit);

    /**
     * Gets the sender's limit used
     * @param _sender address to check
     */
    function getCurrentLimit(address _sender) public view returns (uint256) {
        return limits[_sender].current;
    }

    /**
     * Gets the sender's max limit
     * @param _sender address to check
     */
    function getMaxLimit(address _sender) public view returns (uint256) {
        return limits[_sender].max;
    }

    /**
     * Calculates the limit of sender as a function of time elapsed since last update
     *
     * Consider an example where there is a 1e18 max token limit per day (86400s)
     * If half of a day (43200s) has passed, then there should be a limit of 0.5e18
     *
     * To calculate:
     *   Limit = (Max Token Limit / DURATION) * Elapsed
     *   Elapsed = timestamp - Limit.lastUpdate
     *
     *   If half of the day (43200) has passed, then
     *   (1e18 / 86400) * (86400 - 43200) = 0.5e18
     *
     * The resulting Limit will get added to the existing limit
     */
    function getTargetLimit(address _sender) public view returns (uint256) {
        Limit memory limit = limits[_sender];
        if (limit.max == 0) revert RateLimitNotSet(_sender);

        if (limit.lastUpdate + DURATION > block.timestamp) {
            // If within the cycle, calculate the new target limit
            uint256 elapsed = block.timestamp - limit.lastUpdate;
            uint256 calculatedLimit = limit.current +
                (elapsed * limit.tokenPerSecond);
            return calculatedLimit > limit.max ? limit.max : calculatedLimit;
        } else {
            // If last update is in the previous cycle, return the max limit
            return limit.max;
        }
    }

    /**
     * Sets the max limit for a specific address
     * @param _sender sender address to set
     * @param _newLimit new maxiumum limit to set
     */
    function setTargetLimit(
        address _sender,
        uint256 _newLimit
    ) public onlyOwner returns (Limit memory) {
        Limit storage limit = limits[_sender];
        limit.max = _newLimit;
        limit.tokenPerSecond = _newLimit / DURATION;

        emit RateLimitSet(_sender, _newLimit);

        return limit;
    }

    /**
     * Decreases the sender's current limit if it does not exceed the target limit
     * @param _sender The address to add the limit for
     * @param _newAmount The amount to add to the current limit
     * @return The new limit amount after adding
     */
    function validateAndIncrementLimit(
        address _sender,
        uint256 _newAmount
    ) public returns (uint256) {
        RateLimited.Limit memory limit = limits[_sender];
        uint256 targetLimit = getTargetLimit(_sender);
        if (_newAmount > targetLimit)
            revert RateLimitExceeded(_newAmount, targetLimit);

        // Update the current limit and lastUpdate
        limit.current = targetLimit - _newAmount;
        limit.lastUpdate = block.timestamp;
        limits[_sender] = limit;

        return limit.current;
    }
}
