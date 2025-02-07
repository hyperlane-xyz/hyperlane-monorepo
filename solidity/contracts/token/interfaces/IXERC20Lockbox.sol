// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.4 <0.9.0;

// adapted from https://github.com/defi-wonderland/xERC20

import {IXERC20} from "./IXERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IXERC20Lockbox {
    /**
     * @notice The XERC20 token of this contract
     */
    function XERC20() external returns (IXERC20);

    /**
     * @notice The ERC20 token of this contract
     */
    function ERC20() external returns (IERC20);

    /**
     * @notice Deposit ERC20 tokens into the lockbox
     *
     * @param _amount The amount of tokens to deposit
     */

    function deposit(uint256 _amount) external;

    /**
     * @notice Deposit ERC20 tokens into the lockbox, and send the XERC20 to a user
     *
     * @param _user The user to send the XERC20 to
     * @param _amount The amount of tokens to deposit
     */

    function depositTo(address _user, uint256 _amount) external;

    /**
     * @notice Deposit the native asset into the lockbox, and send the XERC20 to a user
     *
     * @param _user The user to send the XERC20 to
     */

    function depositNativeTo(address _user) external payable;

    /**
     * @notice Withdraw ERC20 tokens from the lockbox
     *
     * @param _amount The amount of tokens to withdraw
     */

    function withdraw(uint256 _amount) external;

    /**
     * @notice Withdraw ERC20 tokens from the lockbox
     *
     * @param _user The user to withdraw to
     * @param _amount The amount of tokens to withdraw
     */

    function withdrawTo(address _user, uint256 _amount) external;
}
