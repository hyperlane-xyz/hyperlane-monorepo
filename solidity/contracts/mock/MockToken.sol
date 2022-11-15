// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract MockToken is ERC20Upgradeable {
    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function burn(uint256 _amount) external {
        _burn(msg.sender, _amount);
    }
}
