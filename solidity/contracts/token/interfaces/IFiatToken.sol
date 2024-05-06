// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

// adapted from https://github.com/circlefin/stablecoin-evm
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFiatToken is IERC20 {
    /**
     * @notice Allows a minter to burn some of its own tokens.
     * @dev The caller must be a minter, must not be blacklisted, and the amount to burn
     * should be less than or equal to the account's balance.
     * @param _amount the amount of tokens to be burned.
     */
    function burn(uint256 _amount) external;

    /**
     * @notice Mints fiat tokens to an address.
     * @param _to The address that will receive the minted tokens.
     * @param _amount The amount of tokens to mint. Must be less than or equal
     * to the minterAllowance of the caller.
     * @return True if the operation was successful.
     */
    function mint(address _to, uint256 _amount) external returns (bool);
}
