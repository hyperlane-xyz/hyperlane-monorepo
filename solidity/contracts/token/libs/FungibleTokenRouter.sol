// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {MovableCollateralRouter} from "./MovableCollateralRouter.sol";

/**
 * @title Hyperlane Fungible Token Router that extends TokenRouter with scaling logic for fungible tokens with different decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter, MovableCollateralRouter {
    uint256 public immutable scale;

    constructor(uint256 _scale, address _mailbox) TokenRouter(_mailbox) {
        scale = _scale;
    }

    /**
     * @dev Scales local amount to message amount (up by scale factor).
     * @inheritdoc TokenRouter
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual override returns (uint256 _messageAmount) {
        _messageAmount = _localAmount * scale;
    }

    /**
     * @dev Scales message amount to local amount (down by scale factor).
     * @inheritdoc TokenRouter
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual override returns (uint256 _localAmount) {
        _localAmount = _messageAmount / scale;
    }
}
