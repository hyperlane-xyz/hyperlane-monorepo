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
        uint40 lastUpdate; /// @notice Timestamp of the last time an action has been taken
        uint256 tokenPerSecond; /// @notice Allowed tokens per second
        uint256 current; /// @notice Limit amount remaining
        uint256 max; /// @notice Maximum token amount
    }

    error RateLimitExceeded(uint256 newLimit, uint256 targetLimit);

    /**
     * Gets the sender's limit remaining
     * @param _sender address to check
     */
    function getLimit(address _sender) public view returns (uint256) {
        return limits[_sender].current;
    }

    /**
     * Calculates the current limit amount of sender based on the time passed since the last update and the configured rate limit.
     *
     * Consider an example where there is a 1e18 token limit per day (86400s).
     * If half of a day (43200s) has passed, then there should be a limit of 0.5e18
     *
     * Token Limit
     * 1e18           0.5e18             0
     * |----------------|----------------|
     * 0              43200            86400
     * Duration
     *
     * To calculate:
     *   Limit Amount left = (Limit / DURATION) * Elapsed
     *   Elapsed = timestamp - Limit.lastUpdate
     *
     *   If half of the day (43200) has passed, then
     *   (1e18 / 86400) * (86400 - 43200) = 0.5e18
     */
    function getTargetLimit(address _sender) public view returns (uint256) {
        Limit memory limit = limits[_sender];
        if (limit.max == 0) revert RateLimitNotSet(_sender);

        uint256 elapsed = (block.timestamp - limit.lastUpdate);
        uint256 currentLimitAmount = (elapsed * limit.tokenPerSecond);

        /// @dev Modulo currentLimitAmount because we should drop any excess limit amount
        return limit.max - (currentLimitAmount % limit.max);
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
     * Adds an amount to the current limit if it does not exceed the target limit
     * @param _sender The address to add the limit for
     * @param _newAmount The amount to add to the current limit
     * @return The new limit amount after adding
     */
    function validateAndIncrementLimit(
        address _sender,
        uint256 _newAmount
    ) public view returns (uint256) {
        RateLimited.Limit memory limit = limits[_sender];
        uint256 targetLimit = getTargetLimit(_sender);
        if (limit.current + _newAmount > targetLimit)
            revert RateLimitExceeded(_newAmount, targetLimit);

        return limit.current + _newAmount;
    }
}
