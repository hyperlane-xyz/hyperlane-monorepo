// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "./HypERC20Collateral.sol";
import "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";

/*This smart contract is built in order to add delegating functionalities to the normal HypERC20Collateral contract.
With this smart contract now you can delegate the voting power of locked tokens to a particular address*/

contract HypERC20CollateralVotable is HypERC20Collateral {
    constructor(address _erc20) HypERC20Collateral(_erc20) {}

    // Using this function you can delegate the voting power
    function delegateVotes(address _L1VoteDelegator) external onlyOwner {
        IVotesUpgradeable(address(wrappedToken)).delegate(_L1VoteDelegator);
    }
}
