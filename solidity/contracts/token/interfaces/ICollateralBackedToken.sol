// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/// @notice Exposes the ERC20 token address of the implementer.
interface ICollateralBackedToken {
    function token() external view returns (address);
}
