// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {ITokenFee} from "../interfaces/ITokenFee.sol";

/**
 * @title Hyperlane Fungible Token Router that extends TokenRouter with scaling logic for fungible tokens with different decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter {
    uint256 public immutable scale;

    ITokenFee public feeRecipient;

    constructor(uint256 _scale, address _mailbox) TokenRouter(_mailbox) {
        scale = _scale;
    }

    function setFeeRecipient(address _feeRecipient) public onlyOwner {
        feeRecipient = ITokenFee(_feeRecipient);
    }

    function _quoteTransferFee(
        uint256 _amount
    ) internal view returns (uint256) {
        if (address(feeRecipient) == address(0)) {
            return 0;
        }

        return feeRecipient.quoteTransfer(_amount);
    }

    function _chargeSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory metadata) {
        uint256 fee = _quoteTransferFee(_amount);
        metadata = _transferFromSender(_amount + fee);
        if (fee > 0) {
            _transferTo(address(feeRecipient), fee);
        }
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
