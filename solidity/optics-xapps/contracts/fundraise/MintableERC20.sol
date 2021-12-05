// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {ERC20} from "../bridge/vendored/OZERC20.sol";
import { IERC20Mintable } from "../../interfaces/bridge/IERC20Mintable.sol";


import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Version0} from "@celo-org/optics-sol/contracts/Version0.sol";

contract MintableERC20 is Version0, ERC20, OwnableUpgradeable, IERC20Mintable {
    function initialize(address _owner) public initializer {
        __Ownable_init();
        transferOwnership(_owner);
    }

    // ============ External Functions ============

    /** @notice Creates `_amnt` tokens and assigns them to `_to`, increasing
     * the total supply.
     * @dev Emits a {Transfer} event with `from` set to the zero address.
     * Requirements:
     * - `to` cannot be the zero address.
     * @param _to The destination address
     * @param _amnt The amount of tokens to be minted
     */
    function mint(address _to, uint256 _amnt) external override onlyOwner {
        _mint(_to, _amnt);
    }
}