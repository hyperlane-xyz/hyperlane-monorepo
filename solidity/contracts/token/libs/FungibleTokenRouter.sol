// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./TokenRouter.sol";
import {Quote, ITokenFee} from "../../interfaces/ITokenBridge.sol";
import {TokenMessage} from "./TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title Hyperlane Fungible Token Router that extends TokenRouter with scaling logic for fungible tokens with different decimals.
 * @author Abacus Works
 */
abstract contract FungibleTokenRouter is TokenRouter {
    using TokenMessage for bytes;
    using TypeCasts for bytes32;
    using StorageSlot for bytes32;

    uint256 public immutable scale;

    bytes32 private constant FEE_RECIPIENT_SLOT =
        keccak256("FungibleTokenRouter.feeRecipient");

    event FeeRecipientSet(address feeRecipient);

    constructor(uint256 _scale, address _mailbox) TokenRouter(_mailbox) {
        scale = _scale;
    }

    /**
     * @notice Sets the fee recipient for the router.
     * @dev Allows for address(0) to be set, which disables fees.
     * @param _feeRecipient The address of the fee recipient.
     */
    function setFeeRecipient(address _feeRecipient) public onlyOwner {
        FEE_RECIPIENT_SLOT.getAddressSlot().value = _feeRecipient;
        emit FeeRecipientSet(_feeRecipient);
    }

    function _getFeeRecipient() internal view virtual returns (address) {
        return FEE_RECIPIENT_SLOT.getAddressSlot().value;
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
        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
        quotes[1] = Quote({
            token: token(),
            amount: _feeAmount(_destination, _recipient, _amount) + _amount
        });
        return quotes;
    }

    function token() public view virtual returns (address);

    function _feeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (uint256 feeAmount) {
        if (_getFeeRecipient() == address(0)) {
            return 0;
        }

        Quote[] memory quotes = ITokenFee(_getFeeRecipient())
            .quoteTransferRemote(_destination, _recipient, _amount);
        require(
            quotes.length == 1 && quotes[0].token == token(),
            "FungibleTokenRouter: fee must match token"
        );
        return quotes[0].amount;
    }

    /**
     * @dev Scales local amount to message amount (up by scale factor).
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual returns (uint256 _messageAmount) {
        _messageAmount = _localAmount * scale;
    }

    /**
     * @dev Scales message amount to local amount (down by scale factor).
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual returns (uint256 _localAmount) {
        _localAmount = _messageAmount / scale;
    }

    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual returns (uint256 dispatchValue) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);
        _transferFromSender(_amount + fee);
        if (fee > 0) {
            _transferTo(_getFeeRecipient(), fee);
        }
        return msg.value;
    }

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        internal
        virtual
        override
        returns (uint256 dispatchValue, bytes memory message)
    {
        dispatchValue = _chargeSender(_destination, _recipient, _amount);
        message = TokenMessage.format(_recipient, _outboundAmount(_amount));
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();

        // effects
        emit ReceivedTransferRemote(_origin, recipient, amount);

        // interactions
        _transferTo(recipient.bytes32ToAddress(), _inboundAmount(amount));
    }
}
