// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {FastTokenRouter} from "../libs/FastTokenRouter.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract FastHypERC20Collateral is FastTokenRouter, HypERC20Collateral {
    using SafeERC20 for IERC20;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(erc20, _scale, _mailbox) {}

    /**
     * @dev delegates transfer logic to `_transferTo`.
     * @inheritdoc FastTokenRouter
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override(FastTokenRouter, TokenRouter) {
        FastTokenRouter._handle(_origin, _sender, _message);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` to `_recipient`.
     * @inheritdoc FastTokenRouter
     */
    function _fastTransferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev Transfers in `_amount` of `wrappedToken` from `_recipient`.
     * @inheritdoc FastTokenRouter
     */
    function _fastRecieveFrom(
        address _sender,
        uint256 _amount
    ) internal override {
        wrappedToken.safeTransferFrom(_sender, address(this), _amount);
    }
}
