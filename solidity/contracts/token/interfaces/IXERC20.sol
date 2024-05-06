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
}
