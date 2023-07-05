// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "./HypERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/draft-ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

/* This smart contract is developed to add Votable extension to normal HypERC20 token. 
With this smart contract you can use your token for voting purposes in DAO
We have included all the important libraries needed for voting extension*/

contract HypERC20Votable is
    HypERC20,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable
{
    constructor(uint8 decimals) HypERC20(decimals) {}

    /**
     * @notice Initializes the Hyperlane router, ERC20 metadata, and mints initial supply to deployer.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _totalSupply The initial supply of the token.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        uint256 _totalSupply,
        string memory _name,
        string memory _symbol
    ) public override initializer {
        // transfers ownership to `msg.sender`
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster
        );

        // Initialize ERC20 metadata
        __ERC20_init(_name, _symbol);
        __ERC20Permit_init(_name);
        _mint(msg.sender, _totalSupply);
    }

    // Below are the functions which needed override

    function decimals()
        public
        view
        override(ERC20Upgradeable, HypERC20)
        returns (uint8)
    {
        return super.decimals();
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        ERC20VotesUpgradeable._afterTokenTransfer(from, to, amount);
    }

    function _mint(address to, uint256 amount)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        super._mint(to, amount);
    }

    function _burn(address account, uint256 amount)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        super._burn(account, amount);
    }
}
