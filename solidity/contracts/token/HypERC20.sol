// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Hyperlane ERC20 Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypERC20 is ERC20, TokenRouter {
    uint8 immutable __decimals;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _mailbox
    ) TokenRouter(_mailbox) ERC20(_name, _symbol) {
        __decimals = _decimals;
        _transferOwnership(msg.sender);
    }

    function decimals() public view override returns (uint8) {
        return __decimals;
    }

    function balanceOf(
        address _account
    ) public view virtual override(TokenRouter, ERC20) returns (uint256) {
        return ERC20.balanceOf(_account);
    }

    /**
     * @dev Burns `_amount` of token from `msg.sender` balance.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        _burn(msg.sender, _amount);
        return bytes(""); // no metadata
    }

    /**
     * @dev Mints `_amount` of token to `_recipient` balance.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        _mint(_recipient, _amount);
    }
}
