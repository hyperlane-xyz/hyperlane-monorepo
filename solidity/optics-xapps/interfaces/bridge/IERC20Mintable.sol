// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20Mintable is IERC20 {
    function mint(address _to, uint256 _amnt) external;
}
