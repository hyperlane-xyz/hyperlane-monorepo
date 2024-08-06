// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

// adapted from https://github.com/defi-wonderland/xERC20

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IXERC20 is IERC20 {
    /**
     * @notice Mints tokens for a user
     * @dev Can only be called by a minter
     * @param _user The address of the user who needs tokens minted
     * @param _amount The amount of tokens being minted
     */
    function mint(address _user, uint256 _amount) external;

    /**
     * @notice Burns tokens for a user
     * @dev Can only be called by a minter
     * @param _user The address of the user who needs tokens burned
     * @param _amount The amount of tokens being burned
     */
    function burn(address _user, uint256 _amount) external;

    /**
     * @notice Updates the limits of any bridge
     * @dev Can only be called by the owner
     * @param _mintingLimit The updated minting limit we are setting to the bridge
     * @param _burningLimit The updated burning limit we are setting to the bridge
     * @param _bridge The address of the bridge we are setting the limits too
     */
    function setLimits(
        address _bridge,
        uint256 _mintingLimit,
        uint256 _burningLimit
    ) external;

    function owner() external returns (address);

    /**
     * @notice Returns the current limit of a bridge
     * @param _bridge the bridge we are viewing the limits of
     * @return _limit The limit the bridge has
     */
    function burningCurrentLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /**
     * @notice Returns the current limit of a bridge
     * @param _bridge the bridge we are viewing the limits of
     * @return _limit The limit the bridge has
     */
    function mintingCurrentLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);

    /**
     * @notice Returns the max limit of a minter
     *
     * @param _minter The minter we are viewing the limits of
     *  @return _limit The limit the minter has
     */
    function mintingMaxLimitOf(
        address _minter
    ) external view returns (uint256 _limit);

    /**
     * @notice Returns the max limit of a bridge
     *
     * @param _bridge the bridge we are viewing the limits of
     * @return _limit The limit the bridge has
     */

    function burningMaxLimitOf(
        address _bridge
    ) external view returns (uint256 _limit);
}
