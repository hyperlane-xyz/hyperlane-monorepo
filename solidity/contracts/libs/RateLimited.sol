// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

library RateLimited {
    uint256 public constant DURATION = 1 days; // 86400

    // mapping(address => Limit) limits
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
        Limit storage limit
    ) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - limit.lastUpdate;
        uint256 currentLimitAmount = (elapsed * limit.tokenPerSecond);
        return limit.max - (currentLimitAmount % limit.max); // Modulo because the amount should never be greater than the max
    }

    /**
     * Sets the new limit amount and rate
     */
    function setLimitAmount(Limit storage limit, uint256 _newLimit) internal {
        limit.max = _newLimit;
        limit.tokenPerSecond = _newLimit / DURATION;

        // TODO do we need to adjust the limit.current?
    }
}
