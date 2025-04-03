// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {IVaultTokenized} from "../vault/IVaultTokenized.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStakerRewards} from "./IStakerRewards.sol";

interface ICompoundStakerRewards {
    function vault() external returns (IVaultTokenized);
    function token() external returns (IERC20);
    function rewards() external returns (IStakerRewards);
    function compound(address network, uint256 maxRewards) external;
}
