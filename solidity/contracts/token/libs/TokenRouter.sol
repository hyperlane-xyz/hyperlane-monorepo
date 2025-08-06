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
     * @notice Returns the address of the token managed by this router. It can be one of three options:
     * - ERC20 token address for fungible tokens that are being collateralized (HypERC20Collateral, HypERC4626, etc.)
     * - 0x0 address for native tokens (ETH, MATIC, etc.) (HypNative, etc.)
     * - address(this) for synthetic ERC20 tokens (HypERC20, etc.)
     * It is being used for quotes and fees from the fee recipient and pulling/push the tokens from the sender/receipient.
     * @dev This function must be implemented by derived contracts to specify the token address.
     * @return The address of the token contract.
     */
    function token() public view virtual returns (address);

    // Determines whether this router handles native tokens from/to the sender/recipient.
    // Only overriden by EverclearEthBridge, generally should use the internal `token` function.
    function transfersNativeTokens() internal view virtual returns (bool) {
        return token() == address(0);
    }

    /** @notice Returns the message dispatch value based on whether this router transfers native
     * tokens. If it does, the amounts with fees (excluding the gas payment) are not to be forwarded
     * to dispatch, if it does not, all of the value (only gas payment) is forwarded to dispatch. If
     * a router takes any fees in native tokens on top, it needs to override this.
     * @param msgValue The original message value.
     * @param amountWithFeeRecipientAndExternalFee The amount with both the feeRecipient fee and external fees included.
     * @return The msg.value to be used for the message dispatch.
     */
    function messageDispatchValue(
        uint256 msgValue,
        uint256 amountWithFeeRecipientAndExternalFee
    ) internal view virtual returns (uint256) {
        if (transfersNativeTokens()) {
            return msgValue - amountWithFeeRecipientAndExternalFee;
        }
        return msgValue;
    }

    function calculateFeesAndCharge(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal returns (uint256 feeRecipientFee, uint256 externalFee) {
        // Calculate the fee amount for the fee recipient
        feeRecipientFee = _feeRecipientAmount(
            _destination,
            _recipient,
            _amount
        );
        externalFee = _externalFeeAmount(_destination, _recipient, _amount);
        _transferFromSender(_amount + feeRecipientFee + externalFee);
        if (feeRecipientFee > 0) {
            _transferTo(feeRecipient(), feeRecipientFee);
        }
    }

    function emitAndDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _tokenMessage,
        uint256 feeRecipientFee,
        uint256 externalFee
    ) internal returns (bytes32 messageId) {
        // effects
        emit SentTransferRemote(_destination, _recipient, _amount);

        // interactions
        // TODO: Consider flattening with GasRouter
        messageId = _GasRouter_dispatch(
            _destination,
            messageDispatchValue(
                msg.value,
                _amount + feeRecipientFee + externalFee
            ),
            _tokenMessage,
            address(hook)
        );
    }

    /**
     * @notice Transfers `_amount` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @dev Override with custom behavior for storing or forwarding tokens. Known overrides:
     * - OPL2ToL1TokenBridgeNative: overrides to add hook metadata for message dispatch
     * - EverclearTokenBridge: overrides to create Everclear intent for cross-chain token transfer
     * - TokenBridgeCctpBase: overrides to add CCTP-specific metadata for message dispatch
     * - HypERC4626Collateral: overrides to deposit into vault and handle shares
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
        (uint256 feeRecipientFee, uint256 externalFee) = calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount
        );

        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount)
        );

        return
            emitAndDispatch(
                _destination,
                _recipient,
                _amount,
                _tokenMessage,
                feeRecipientFee,
                externalFee
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
    ) internal view virtual returns (uint256) {
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
     * @dev Should be overridden by derived contracts if they have additional fees (currently only OpL2NativeTokenBridge)
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        uint256 gasPayment = _quoteGasPayment(
            _destination,
            _recipient,
            _amount
        );
        uint256 feeRecipientFee = _feeRecipientAmount(
            _destination,
            _recipient,
            _amount
        );
        uint256 externalFee = _externalFeeAmount(
            _destination,
            _recipient,
            _amount
        );
        if (transfersNativeTokens()) {
            quotes = new Quote[](1);
            quotes[0] = Quote({
                token: address(0),
                amount: gasPayment + feeRecipientFee + externalFee + _amount
            });
        } else {
            quotes = new Quote[](2);
            quotes[0] = Quote({token: address(0), amount: gasPayment});
            quotes[1] = Quote({
                token: token(),
                amount: feeRecipientFee + externalFee + _amount
            });
        }
        return quotes;
    }

    // To be overridden by derived contracts if they have additional fees
    function _externalFeeAmount(
        uint32, // _destination,
        bytes32, // _recipient,
        uint256 // _amount
    ) internal view virtual returns (uint256 feeAmount) {
        return 0;
    }

    function _feeRecipientAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (uint256 feeAmount) {
        // TODO: This still incurs a SLOAD for fetching feeRecipient, consider allowing children to override this in bytecode
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
