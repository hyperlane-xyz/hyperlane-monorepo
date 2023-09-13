// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {FastTransfer} from "./libs/FastTransfer.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract FastHypERC20Collateral is FastTransfer, HypERC20Collateral {
    using SafeERC20 for IERC20;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(address erc20) HypERC20Collateral(erc20) {}

    /**
     * @dev Transfers `_amount` of `wrappedToken` to `_recipient`/`fastFiller` who provided LP.
     * @inheritdoc FastTransfer
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) internal virtual override(FastTransfer, HypERC20Collateral) {
        FastTransfer._transferTo(_recipient, _amount, _metadata);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` to `_recipient`.
     * @inheritdoc FastTransfer
     */
    function _fastTransferTo(address _recipient, uint256 _amount)
        internal
        override
    {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev Transfers in `_amount` of `wrappedToken` from `_recipient`.
     * @inheritdoc FastTransfer
     */
    function _fastRecieveFrom(address _sender, uint256 _amount)
        internal
        override
    {
        wrappedToken.safeTransferFrom(_sender, address(this), _amount);
    }
}
