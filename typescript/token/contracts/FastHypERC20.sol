// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20} from "./HypERC20.sol";
import {FastTransfer} from "./libs/FastTransfer.sol";
import {Message} from "./libs/Message.sol";

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract FastHypERC20 is FastTransfer, HypERC20 {
    constructor(uint8 __decimals) HypERC20(__decimals) {}

    /**
     * @dev Mints `_amount` of token to `_recipient`/`fastFiller` who provided LP.
     * @inheritdoc FastTransfer
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal override(FastTransfer, HypERC20) {
        FastTransfer._transferTo(_recipient, _amount, _metadata);
    }

    /**
     * @dev Mints `_amount` of tokens to `_recipient`.
     * @inheritdoc FastTransfer
     */
    function _fastTransferTo(address _recipient, uint256 _amount)
        internal
        override
    {
        _mint(_recipient, _amount);
    }

    /**
     * @dev Burns `_amount` of tokens from `_recipient`.
     * @inheritdoc FastTransfer
     */
    function _fastRecieveFrom(address _sender, uint256 _amount)
        internal
        override
    {
        _burn(_sender, _amount);
    }
}
