// SPDX-License-Identifier: BSD-3.0
pragma solidity >=0.8.19 <0.9.0;

/// @notice two rate storage slots per rate limit
struct RateLimitMidPoint {
    //// -------------------------------------------- ////
    //// ------------------ SLOT 0 ------------------ ////
    //// -------------------------------------------- ////
    /// @notice the rate per second for this contract
    uint128 rateLimitPerSecond;
    /// @notice the cap of the buffer that can be used at once
    uint112 bufferCap;
    //// -------------------------------------------- ////
    //// ------------------ SLOT 1 ------------------ ////
    //// -------------------------------------------- ////
    /// @notice the last time the buffer was used by the contract
    uint32 lastBufferUsedTime;
    /// @notice the buffer at the timestamp of lastBufferUsedTime
    uint112 bufferStored;
    /// @notice the mid point of the buffer
    uint112 midPoint;
}
