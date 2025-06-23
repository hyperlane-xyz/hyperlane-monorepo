// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {Quote, ITokenFee} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "./Quotes.sol";

/**
 * @title Hyperlane Fungible Token Router that extends TokenRouter with scaling logic for fungible tokens with different decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter {
    using Quotes for Quote[];

    uint256 public immutable scale;

    ITokenFee public feeRecipient;

    constructor(uint256 _scale, address _mailbox) TokenRouter(_mailbox) {
        scale = _scale;
    }

    function setFeeRecipient(address _feeRecipient) public onlyOwner {
        feeRecipient = ITokenFee(_feeRecipient);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        Quote[] memory internalQuotes = _internalQuotes(
            _destination,
            _recipient,
            _amount
        );
        Quote[] memory feeQuotes = _feeQuotes(
            _destination,
            _recipient,
            _amount
        );
        quotes = new Quote[](internalQuotes.length + feeQuotes.length);

        uint8 i;
        for (i = 0; i < internalQuotes.length; i++) {
            quotes[i] = internalQuotes[i];
        }
        for (i = 0; i < feeQuotes.length; i++) {
            quotes[internalQuotes.length + i] = feeQuotes[i];
        }
        return quotes;
    }

    function _token() internal view virtual returns (address);

    function _internalQuotes(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (Quote[] memory quotes) {
        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
        quotes[1] = Quote({token: _token(), amount: _amount});
        return quotes;
    }

    function _feeQuotes(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (Quote[] memory quotes) {
        if (address(feeRecipient) == address(0)) {
            return new Quote[](0);
        }

        return
            feeRecipient.quoteTransferRemote(_destination, _recipient, _amount);
    }

    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 unspentValue) {
        unspentValue = _feeQuotes(_destination, _recipient, _amount)
            .chargeSender(address(feeRecipient));
        _transferFromSender(_amount);
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
