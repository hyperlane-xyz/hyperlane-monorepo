// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";

/**
 * @title Hyperlane Fungible Token Router that extends TokenRouter with scaling logic for fungible tokens with different decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter {
    uint128 public immutable scaleNumerator;
    uint128 public immutable scaleDenominator;

    uint128 public immutable feeNumerator;
    uint128 public immutable feeDenominator;
    address public immutable feeRecipient;

    constructor(uint256 _scale, address _mailbox) TokenRouter(_mailbox) {
        scaleNumerator = uint128(_scale);
        scaleDenominator = 1;
        feeRecipient = address(1);
        feeNumerator = 0;
        feeDenominator = 1;
    }

    function _quoteTransferFee(
        uint256 _amount
    ) internal view returns (uint256) {
        return (_amount * feeNumerator) / feeDenominator;
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        uint256 fee = _quoteTransferFee(_amount);
        if (fee > 0) {
            _transferFromSender(fee);
            _transferTo(feeRecipient, fee, msg.data[0:0]);
        }

        return
            TokenRouter._transferRemote(
                _destination,
                _recipient,
                _amount,
                _value,
                _hookMetadata,
                _hook
            );
    }

    /**
     * @dev Scales local amount to message amount (up by scale factor).
     * @inheritdoc TokenRouter
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual override returns (uint256 _messageAmount) {
        _messageAmount = (_localAmount * scaleNumerator) / scaleDenominator;
    }

    /**
     * @dev Scales message amount to local amount (down by scale factor).
     * @inheritdoc TokenRouter
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual override returns (uint256 _localAmount) {
        _localAmount = (_messageAmount * scaleDenominator) / scaleNumerator;
    }
}
