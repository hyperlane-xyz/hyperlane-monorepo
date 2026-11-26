// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVeruLinkToken is IERC20 {
    /// @notice Mints tokens to a recipient. Requires the caller's MINTER_ROLE.
    function mint(address _recipient, uint256 _amount) external;

    /// @notice Burns tokens from an account using its allowance to the caller.
    function burnFrom(address _account, uint256 _amount) external;
}
