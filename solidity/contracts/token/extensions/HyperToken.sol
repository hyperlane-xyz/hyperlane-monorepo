// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import {HypERC20} from "../HypERC20.sol";

/// @title HyperToken - The Hyperlane protocol's token contract.
/// @notice This contract extends HypERC20 with access controlled local minting and burning.
/// @dev Uses OpenZeppelin upgradeable contracts and Hyperlane's TokenRouter for bridging.
/// @custom:security-contact security@hyperlane.xyz
contract HyperToken is
    HypERC20,
    AccessControlUpgradeable,
    ERC20BurnableUpgradeable
{
    /// @notice Role identifier for addresses allowed to mint tokens.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role identifier for addresses allowed to burn tokens.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice Constructor for HyperToken contract.
    /// @dev Calls the TokenRouter constructor and disables initializers.
    /// @param __decimals The number of decimals for the token.
    /// @param _scale The scale factor for the token.
    /// @param _mailbox The address of the mailbox contract.
    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox
    ) HypERC20(__decimals, _scale, _mailbox) {
        _disableInitializers();
    }

    /// @notice Initializes the HyperToken contract with initial configuration.
    /// @dev This function can only be called once due to the initializer modifier.
    /// @param _initialSupply The initial total supply of tokens to mint to the owner.
    /// @param _name The name of the token.
    /// @param _symbol The symbol of the token.
    /// @param _hook The address of the hook contract for mailbox functionality.
    /// @param _interchainSecurityModule The address of the interchain security module.
    /// @param _owner The address of the contract owner.
    function initialize(
        uint256 _initialSupply,
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        __ERC20_init(_name, _symbol);
        __ERC20Burnable_init();
        __ERC20Permit_init(_name);
        _mint(_owner, _initialSupply);

        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);

        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    /// @notice Mints new tokens to a specified address.
    /// @dev Only addresses with MINTER_ROLE can call this function.
    /// @param _to The address that will receive the minted tokens.
    /// @param _amount The amount of tokens to mint.
    function mint(address _to, uint256 _amount) public virtual {
        _checkRole(MINTER_ROLE);
        _mint(_to, _amount);
    }

    /// @notice Burns tokens from a specified address.
    /// @dev Only addresses with BURNER_ROLE can call this function.
    /// @param _from The address from which tokens will be burned.
    /// @param _amount The amount of tokens to burn.
    function burn(address _from, uint256 _amount) public virtual {
        _checkRole(BURNER_ROLE);
        _burn(_from, _amount);
    }

    /// @inheritdoc ERC20Upgradeable
    function decimals()
        public
        view
        virtual
        override(ERC20Upgradeable, HypERC20)
        returns (uint8)
    {
        return HypERC20.decimals();
    }

    /// @inheritdoc ERC20Upgradeable
    function balanceOf(
        address _account
    )
        public
        view
        virtual
        override(ERC20Upgradeable, HypERC20)
        returns (uint256)
    {
        return ERC20Upgradeable.balanceOf(_account);
    }
}
