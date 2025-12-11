// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {Quote} from "../interfaces/ITokenBridge.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypERC20 is ERC20Upgradeable, TokenRouter {
    uint8 private immutable _decimals;

    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        _decimals = __decimals;
    }

    /**
     * @notice Initializes the Hyperlane router, ERC20 metadata, and mints initial supply to deployer.
     * @param _totalSupply The initial supply of the token.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     */
    function initialize(
        uint256 _totalSupply,
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        // Initialize ERC20 metadata
        __ERC20_init(_name, _symbol);
        _mint(msg.sender, _totalSupply);
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: _interchainSecurityModule,
            _owner: _owner
        });
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(this);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to burn `_amount` of token from `msg.sender` balance.
     * @dev Known overrides:
     * - HypERC4626: Converts the amount to shares and burns from the User (via HypERC20 implementation)
     */
    // solhint-disable-next-line hyperlane/no-virtual-override
    function _transferFromSender(uint256 _amount) internal virtual override {
        _burn(msg.sender, _amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint `_amount` of token to `_recipient` balance.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        _mint(_recipient, _amount);
    }
}
