// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {Quote, ITokenFee} from "../../interfaces/ITokenBridge.sol";

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
        // allows for address(0) to be set, which disables fees
        feeRecipient = ITokenFee(_feeRecipient);
    }

    /**
     * @inheritdoc ITokenFee
     * @dev Returns fungible fee and bridge amounts separately for client to easily distinguish.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        quotes = new Quote[](3);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
        quotes[1] = Quote({
            token: _token(),
            amount: _feeAmount(_destination, _recipient, _amount)
        });
        quotes[2] = Quote({token: _token(), amount: _amount});
        return quotes;
    }

    function _token() internal view virtual returns (address);

    function _feeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (uint256 feeAmount) {
        if (address(feeRecipient) == address(0)) {
            return 0;
        }

        Quote[] memory quotes = feeRecipient.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        require(
            quotes.length == 1 && quotes[0].token == _token(),
            "FungibleTokenRouter: fee must match token"
        );
        return quotes[0].amount;
    }

    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 unspentValue) {
        unspentValue = msg.value;
        uint256 fee = _feeAmount(_destination, _recipient, _amount);
        _transferFromSender(_amount + fee);

        if (fee > 0) {
            uint256 balanceBefore = address(this).balance;
            _transferTo(address(feeRecipient), fee);
            uint256 nativeFee = balanceBefore - address(this).balance;
            unspentValue -= nativeFee;
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
