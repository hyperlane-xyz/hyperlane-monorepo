// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

contract RateLimited {
    uint256 public constant DURATION = 1 days; // 86400

    mapping(address sender => Limit limit) public limits;

    event RateLimitSet(address route, uint256 amount);

    /**
     * @param lastUpdate Timestamp of the last time an action has been taken
     * @param tokenPerSecond Token per second limit
     * @param current Limit amount left
     * @param max Maximum token amount
     */
    struct Limit {
        uint40 lastUpdate;
        uint256 tokenPerSecond;
        uint256 current;
        uint256 max;
    }

    /**
     * Calculates the current limit amount of sender based on the time passed since the last update and the configured rate limit.
     *
     * Consider an example where there is a 1e18 token limit per day (86400s).
     * If half of a day (43200s) has passed, then there should be a limit of 0.5e18
     *
     * Token Limit
     * 1e18						0.5e18						 0
     * |--------------------------|--------------------------|
     * 0						43200					   86400
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
        uint256 elapsed = (block.timestamp - limit.lastUpdate);
        uint256 currentLimitAmount = (elapsed * limit.tokenPerSecond);

        /// @dev Modulo is used because the currentLimitAmount can be greater than the max because elapsed time can exceed the DURATION
        return limit.max - (currentLimitAmount % limit.max);
    }

    /**
     * Sets the max limit for a sender address
     * @param _sender sender address to set
     * @param _newLimit amount to set
     */
    function setLimit(
        address _sender,
        uint256 _newLimit
    ) public returns (Limit memory) {
        Limit storage limit = limits[_sender];
        limit.max = _newLimit;
        limit.tokenPerSecond = _newLimit / DURATION;
        // TODO do we need to adjust the limit.current?

        emit RateLimitSet(_sender, _newLimit);

        return limit;
    }
}
