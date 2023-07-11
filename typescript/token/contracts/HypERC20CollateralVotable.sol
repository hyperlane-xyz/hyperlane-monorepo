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

    function getVotes(address account)
        external
        view
        override
        returns (uint256)
    {}

    function getPastVotes(address account, uint256 timepoint)
        external
        view
        override
        returns (uint256)
    {}

    function getPastTotalSupply(uint256 timepoint)
        external
        view
        override
        returns (uint256)
    {}

    function delegates(address account)
        external
        view
        override
        returns (address)
    {}

    function delegateBySig(
        address delegatee,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {}
}
