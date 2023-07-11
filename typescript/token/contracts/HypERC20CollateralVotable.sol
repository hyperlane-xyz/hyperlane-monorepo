// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "./HypERC20Collateral.sol";
import "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing votable ERC20 with remote transfer functionality.
 * @author  Arman Aurobindo @armanthepythonguy
 */
contract HypERC20CollateralVotable is HypERC20Collateral, IVotesUpgradeable {
    constructor(address _erc20) HypERC20Collateral(_erc20) {}

    // Using this function you can delegate the voting power
    function delegate(address _L1VoteDelegator) external override onlyOwner {
        IVotesUpgradeable(address(wrappedToken)).delegate(_L1VoteDelegator);
    }
}
