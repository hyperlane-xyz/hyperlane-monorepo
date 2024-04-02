// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

contract RateLimited {
    uint256 public constant DURATION = 1 days; // 86400

    mapping(address sender => RateLimited.Limit) public limits;

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
     * Calculates the current limit amount based on the time passed since the last update and the configured rate limit.
     *
     * Token Limit
     * 1e18						0.5e18						 0
     * |--------------------------|--------------------------|
     * 0						43200					   86400
     * Duration
     *
     * Amount left = Limit.tokenPerSecond * Elapsed
     * Elapsed = timestamp - Limit.lastUpdate
     *
     * If half of the day (43200) has passed, then
     * (1e18 / 86400) * (86400 - 43200) = 0.5e18
     */
    function getCurrentLimitAmount(
        address _sender
    ) public view returns (uint256) {
        Limit memory limit = limits[_sender];
        uint256 elapsed = (block.timestamp - limit.lastUpdate);
        uint256 currentLimitAmount = (elapsed * limit.tokenPerSecond);

        /// @dev Modulo is used because the currentLimitAmount can be greater than the max because elapsed time can exceed the DURATION
        return limit.max - (currentLimitAmount % limit.max);
    }

    /**
     * Sets the max limit for a route address
     * @param _sender sender address to set
     * @param _newLimit amount to set
     */
    function setLimitAmount(
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
