// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {RateLimitMidPoint} from "../../libs/RateLimitMidpointCommonLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IXERC20VS is IERC20 {
    /// @notice Emits when a limit is set
    /// @param _bridge The address of the bridge we are setting the limit to
    /// @param _bufferCap The updated buffer cap for the bridge
    event BridgeLimitsSet(address indexed _bridge, uint256 _bufferCap);

    struct RateLimitMidPointInfo {
        /// @notice the buffer cap for this bridge
        uint112 bufferCap;
        /// @notice the rate limit per second for this bridge
        uint128 rateLimitPerSecond;
        /// @notice the bridge address
        address bridge;
    }

    /// @notice The address of the lockbox contract
    function lockbox() external view returns (address);

    /// @notice Maps bridge address to bridge rate limits
    /// @param _bridge The bridge we are viewing the limits of
    /// @return _rateLimit The limits of the bridge
    function rateLimits(
        address _bridge
    ) external view returns (RateLimitMidPoint memory _rateLimit);

    /// @notice Returns the max limit of a bridge
    /// @param _bridge The bridge we are viewing the limits of
    /// @return _limit The limit the bridge has
    function mintingMaxLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /// @notice Returns the max limit of a bridge
    /// @param _bridge the bridge we are viewing the limits of
    /// @return _limit The limit the bridge has
    function burningMaxLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /// @notice Returns the current limit of a bridge
    /// @param _bridge The bridge we are viewing the limits of
    /// @return _limit The limit the bridge has
    function mintingCurrentLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /// @notice Returns the current limit of a bridge
    /// @param _bridge the bridge we are viewing the limits of
    /// @return _limit The limit the bridge has
    function burningCurrentLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /// @notice Mints tokens for a user
    /// @dev Can only be called by a bridge
    /// @param _user The address of the user who needs tokens minted
    /// @param _amount The amount of tokens being minted
    function mint(address _user, uint256 _amount) external;

    /// @notice Burns tokens for a user
    /// @dev Can only be called by a bridge
    /// @param _user The address of the user who needs tokens burned
    /// @param _amount The amount of tokens being burned
    function burn(address _user, uint256 _amount) external;

    /// @notice Conform to the xERC20 setLimits interface
    /// @dev Can only be called if the bridge already has a buffer cap
    /// @param _bridge The bridge we are setting the limits of
    /// @param _newBufferCap The new buffer cap, uint112 max for unlimited
    function setBufferCap(address _bridge, uint256 _newBufferCap) external;

    /// @notice Sets rate limit per second for a bridge
    /// @dev Can only be called if the bridge already has a buffer cap
    /// @param _bridge The bridge we are setting the limits of
    /// @param _newRateLimitPerSecond The new rate limit per second
    function setRateLimitPerSecond(
        address _bridge,
        uint128 _newRateLimitPerSecond
    ) external;

    /// @notice Adds a new bridge to the currently active bridges
    /// @param _newBridge The bridge to add
    function addBridge(RateLimitMidPointInfo memory _newBridge) external;

    /// @notice Removes a bridge from the currently active bridges
    /// deleting its buffer stored, buffer cap, mid point and last
    /// buffer used time
    /// @param _bridge The bridge to remove
    function removeBridge(address _bridge) external;
}
