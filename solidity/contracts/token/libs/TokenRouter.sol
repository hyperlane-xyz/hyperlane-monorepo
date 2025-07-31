// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {GasRouter} from "../../client/GasRouter.sol";
import {TokenMessage} from "./TokenMessage.sol";
import {Quote, ITokenBridge, ITokenFee} from "../../interfaces/ITokenBridge.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title Hyperlane Token Router that extends Router with abstract token (ERC20/ERC721) remote transfer functionality.
 * @author Abacus Works
 */
abstract contract TokenRouter is GasRouter, ITokenBridge {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;
    using StorageSlot for bytes32;

    /**
     * @dev Emitted on `transferRemote` when a transfer message is dispatched.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amountOrId The amount or ID of tokens sent in to the remote recipient.
     */
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amountOrId
    );

    /**
     * @dev Emitted on `_handle` when a transfer message is processed.
     * @param origin The identifier of the origin chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amountOrId The amount or ID of tokens received from the remote sender.
     */
    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amountOrId
    );

    uint256 public immutable scale;

    bytes32 private constant FEE_RECIPIENT_SLOT =
        keccak256("FungibleTokenRouter.feeRecipient");

    event FeeRecipientSet(address feeRecipient);

    constructor(uint256 _scale, address _mailbox) GasRouter(_mailbox) {
        scale = _scale;
    }

    /**
     * @notice Returns the address of the token managed by this router.
     * @dev This function must be implemented by derived contracts to specify the token address.
     * @return The address of the token contract.
     */
    function token() public view virtual returns (address);

    function dispatchValue(
        uint256 msgValue,
        uint256 amountWithFee
    ) internal view virtual returns (uint256) {
        if (token() == address(0)) {
            return msgValue - amountWithFee;
        }
        return msgValue;
    }

    /**
     * @notice Transfers `_amount` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount or identifier of tokens to be sent to the remote recipient.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual returns (bytes32 messageId) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);
        _transferFromSender(_amount + fee);
        if (fee > 0) {
            _transferTo(feeRecipient(), fee);
        }

        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount)
        );

        // effects
        emit SentTransferRemote(_destination, _recipient, _amount);

        // interactions
        // TODO: Consider flattening with GasRouter
        messageId = _GasRouter_dispatch(
            _destination,
            dispatchValue(msg.value, _amount + fee),
            _tokenMessage,
            address(hook)
        );
    }

    /**
     * @dev Should transfer `_amount` of tokens from `msg.sender` to this token router.
     * @dev Called by `transferRemote` before message dispatch.
     */
    function _transferFromSender(uint256 _amountOrId) internal virtual;

    /**
     * DEPRECATED: Use `quoteTransferRemote` instead.
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destinationDomain The domain of the router.
     * @dev Assumes bytes32(0) recipient and max amount of tokens for quoting.
     * @return payment How much native value to send in transferRemote call.
     */
    function quoteGasPayment(
        uint32 _destinationDomain
    ) public view virtual override returns (uint256) {
        return
            _quoteGasPayment(_destinationDomain, bytes32(0), type(uint256).max);
    }

    function _quoteGasPayment(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal view returns (uint256) {
        return
            _GasRouter_quoteDispatch(
                _destinationDomain,
                TokenMessage.format(_recipient, _amount),
                address(hook)
            );
    }

    /**
     * @dev Should transfer `_amountOrId` of tokens from this token router to `_recipient`.
     * @dev Called by `handle` after message decoding.
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal virtual;

    // ===========================
    // ========== Former FungibleTokenRouter functions
    // ===========================

    /**
     * @notice Sets the fee recipient for the router.
     * @dev Allows for address(0) to be set, which disables fees.
     * @param _feeRecipient The address of the fee recipient.
     */
    function setFeeRecipient(address _feeRecipient) public onlyOwner {
        FEE_RECIPIENT_SLOT.getAddressSlot().value = _feeRecipient;
        emit FeeRecipientSet(_feeRecipient);
    }

    function feeRecipient() public view virtual returns (address) {
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

    // TODO: add documentation, that this is the fee amount for token bridging purposes but only for the feeRecipient, unlike quoteTransferRemote which quotes the total amount (including fee + gas payment)
    // Have to figure this out how this overlaps with fees for underlying bridges
    function _feeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (uint256 feeAmount) {
        if (feeRecipient() == address(0)) {
            return 0;
        }

        Quote[] memory quotes = ITokenFee(feeRecipient()).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        if (quotes.length == 0) {
            return 0;
        }

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
