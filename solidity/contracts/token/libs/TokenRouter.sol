// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {GasRouter} from "../../client/GasRouter.sol";
import {TokenMessage} from "./TokenMessage.sol";
import {Quote, ITokenBridge, ITokenFee} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "./Quotes.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/**
 * @title Hyperlane Token Router that extends Router with abstract token (ERC20/ERC721) remote transfer functionality.
 * @dev Overridable functions:
 *  - token(): specify the managed token address
 *  - _transferFromSender(uint256): pull tokens/ETH from msg.sender
 *  - _transferTo(address,uint256): send tokens/ETH to the recipient
 *  - _externalFeeAmount(uint32,bytes32,uint256): compute external fees (default returns 0)
 * @dev Override transferRemote only to implement custom logic that can't be accomplished with the above functions.
 *
 * @author Abacus Works
 */
abstract contract TokenRouter is GasRouter, ITokenBridge {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;
    using StorageSlot for bytes32;
    using Quotes for Quote[];

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

    // cannot use compiler assigned slot without
    // breaking backwards compatibility of storage layout
    bytes32 private constant FEE_RECIPIENT_SLOT =
        keccak256("FungibleTokenRouter.feeRecipient");

    event FeeRecipientSet(address feeRecipient);

    constructor(uint256 _scale, address _mailbox) GasRouter(_mailbox) {
        scale = _scale;
    }

    // ===========================
    // ========== Main API ==========
    // ===========================

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

    /**
     * @inheritdoc ITokenFee
     * @notice Implements the standardized fee quoting interface for token transfers based on
     * overridable internal functions of _quoteGasPayment, _feeRecipientAndAmount, and _externalFeeAmount.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount or identifier of tokens to be sent to the remote recipient
     * @return quotes An array of Quote structs representing the fees in different tokens.
     * @dev This function may return multiple quotes with the same denomination. Convention is to return:
     *  [index 0] native fees charged by the mailbox dispatch
     *  [index 1] then any internal warp route fees (amount bridged plus fee recipient)
     *  [index 2] then any external bridging fees (if any, else 0)
     * These are surfaced as separate elements to enable clients to interpret/render fees independently.
     * There is a Quotes library with an extract function for onchain quoting in a specific denomination,
     * but we discourage onchain quoting in favor of offchain quoting and overpaying with refunds.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](3);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment({
                _destination: _destination,
                _recipient: _recipient,
                _amount: _amount
            })
        });
        (, uint256 feeAmount) = _feeRecipientAndAmount({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount
        });
        quotes[1] = Quote({token: token(), amount: _amount + feeAmount});
        quotes[2] = Quote({
            token: token(),
            amount: _externalFeeAmount(_destination, _recipient, _amount)
        });
    }

    /**
     * @notice Transfers `_amount` token to `_recipient` on the `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * Emits `SentTransferRemote` event on the origin chain.
     * Override with custom behavior for storing or forwarding tokens.
     * Known overrides:
     * - OPL2ToL1TokenBridgeNative: adds hook metadata for message dispatch.
     * - EverclearTokenBridge: creates Everclear intent for cross-chain token transfer.
     * - TokenBridgeCctpBase: adds CCTP-specific metadata for message dispatch.
     * - HypERC4626Collateral: deposits into vault and handles shares.
     * When overriding, mirror the general flow of this function for consistency:
     * 1. Calculate fees and charge the sender.
     * 2. Prepare the token message with recipient, amount, and any additional metadata.
     * 3. Emit `SentTransferRemote` event.
     * 4. Dispatch the message.
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
        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount,
            _msgValue: msg.value
        });

        uint256 scaledAmount = _outboundAmount(_amount);

        // 2. Prepare the token message with the recipient and amount
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            scaledAmount
        );

        // 3. Emit the SentTransferRemote event and 4. dispatch the message
        return
            _emitAndDispatch({
                _destination: _destination,
                _recipient: _recipient,
                _amount: scaledAmount,
                _messageDispatchValue: remainingNativeValue,
                _tokenMessage: _tokenMessage
            });
    }

    // ===========================
    // ========== Internal convenience functions for readability ==========
    // ==========================
    function _calculateFeesAndCharge(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _msgValue
    ) internal returns (uint256 externalFee, uint256 remainingNativeValue) {
        (address _feeRecipient, uint256 feeAmount) = _feeRecipientAndAmount({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount
        });
        externalFee = _externalFeeAmount(_destination, _recipient, _amount);
        uint256 charge = _amount + feeAmount + externalFee;
        _transferFromSender(charge);
        if (feeAmount > 0) {
            // transfer atomically so we don't need to keep track of collateral
            // and fee balances separately
            _transferFee(_feeRecipient, feeAmount);
        }
        remainingNativeValue = token() != address(0)
            ? _msgValue
            : _msgValue - charge;
    }

    // Emits the SentTransferRemote event and dispatches the message.
    function _emitAndDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _messageDispatchValue,
        bytes memory _tokenMessage
    ) internal returns (bytes32 messageId) {
        // effects
        emit SentTransferRemote({
            destination: _destination,
            recipient: _recipient,
            amountOrId: _amount
        });

        // interactions
        messageId = _Router_dispatch({
            _destinationDomain: _destination,
            _value: _messageDispatchValue,
            _messageBody: _tokenMessage,
            _hookMetadata: _GasRouter_hookMetadata(_destination),
            _hook: address(hook)
        });
    }

    // ===========================
    // ========== Fees & Quoting ==========
    // ===========================

    /**
     * @notice Sets the fee recipient for the router.
     * @dev Allows for address(0) to be set, which disables fees.
     * @param recipient The address that receives fees.
     */
    function setFeeRecipient(address recipient) public onlyOwner {
        require(recipient != address(this), "Fee recipient cannot be self");
        FEE_RECIPIENT_SLOT.getAddressSlot().value = recipient;
        emit FeeRecipientSet(recipient);
    }

    /**
     * @notice Returns the address of the fee recipient.
     * @dev Returns address(0) if no fee recipient is set.
     * @dev Can be overridden with address(0) to disable fees entirely.
     * @return address of the fee recipient.
     */
    function feeRecipient() public view virtual returns (address) {
        return FEE_RECIPIENT_SLOT.getAddressSlot().value;
    }

    // To be overridden by derived contracts if they have additional fees
    /**
     * @notice Returns the external fee amount for the given parameters.
     * param _destination The identifier of the destination chain.
     * param _recipient The address of the recipient on the destination chain.
     * param _amount The amount or identifier of tokens to be sent to the remote recipient
     * @return feeAmount The external fee amount.
     * @dev This fee must be denominated in the `token()` defined by this router.
     * @dev The default implementation returns 0, meaning no external fees are charged.
     * This function is intended to be overridden by derived contracts that have additional fees.
     * Known overrides:
     * - TokenBridgeCctpBase: for CCTP-specific fees
     * - EverclearTokenBridge: for Everclear-specific fees
     */
    function _externalFeeAmount(
        uint32, // _destination,
        bytes32, // _recipient,
        uint256 // _amount
    ) internal view virtual returns (uint256 feeAmount) {
        return 0;
    }

    /**
     * @notice Returns the fee recipient amount for the given parameters.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount or identifier of tokens to be sent to the remote recipient
     * @return _feeRecipient The address of the fee recipient.
     * @return feeAmount The fee recipient amount.
     * @dev This function is is not intended to be overridden as storage and logic is contained in TokenRouter.
     */
    function _feeRecipientAndAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view returns (address _feeRecipient, uint256 feeAmount) {
        _feeRecipient = feeRecipient();
        if (_feeRecipient == address(0)) {
            return (_feeRecipient, 0);
        }

        Quote[] memory quotes = ITokenFee(_feeRecipient).quoteTransferRemote({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount
        });
        if (quotes.length == 0) {
            return (_feeRecipient, 0);
        }

        require(
            quotes.length == 1 && quotes[0].token == token(),
            "FungibleTokenRouter: fee must match token"
        );
        feeAmount = quotes[0].amount;
    }

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount or identifier of tokens to be sent to the remote recipient
     * @return payment How much native value to send in transferRemote call.
     * @dev This function is intended to be overridden by derived contracts that trigger multiple messages.
     * Known overrides:
     * - OPL2ToL1TokenBridgeNative: Quote for two messages (prove and finalize).
     */
    function _quoteGasPayment(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (uint256) {
        return
            _Router_quoteDispatch({
                _destinationDomain: _destination,
                _messageBody: TokenMessage.format(_recipient, _amount),
                _hookMetadata: _GasRouter_hookMetadata(_destination),
                _hook: address(hook)
            });
    }

    // ===========================
    // ========== Internal virtual functions for token handling ==========
    // ===========================

    /**
     * @dev Should transfer `_amount` of tokens from `msg.sender` to this token router.
     * Called by `transferRemote` before message dispatch.
     * Known overrides:
     * - HypERC20: Burns the tokens from the sender.
     * - HypERC20Collateral: Pulls the tokens from the sender.
     * - HypNative: Asserts msg.value >= _amount
     * - TokenBridgeCctpBase: (like HypERC20Collateral) Pulls the tokens from the sender.
     * - EverclearEthTokenBridge: Wraps the native token (ETH) to WETH
     * - HypERC4626: Converts the amounts to shares and burns from the User (via HypERC20 implementation)
     * - HypFiatToken: Pulls the tokens from the sender and burns them on the FiatToken contract.
     * - HypXERC20: Burns the tokens from the sender.
     * - HypXERC20Lockbox: Pulls the tokens from the sender, locks them in the XERC20Lockbox contract and burns the resulting xERC20 tokens.
     */
    function _transferFromSender(uint256 _amountOrId) internal virtual;

    /**
     * @dev Should transfer `_amountOrId` of tokens from this token router to `_recipient`.
     * @dev Called by `handle` after message decoding.
     * Known overrides:
     * - HypERC20: Mints the tokens to the recipient.
     * - HypERC20Collateral: Releases the tokens to the recipient.
     * - HypNative: Releases native tokens to the recipient.
     * - TokenBridgeCctpBase: Do nothing (CCTP transfers tokens to the recipient directly).
     * - EverclearEthTokenBridge: Unwraps WETH to ETH and sends to the recipient.
     * - HypERC4626: Converts the amount to shares and mints to the User (via HypERC20 implementation)
     * - HypFiatToken: Mints the tokens to the recipient on the FiatToken contract.
     * - HypXERC20: Mints the tokens to the recipient.
     * - HypXERC20Lockbox: Withdraws the underlying tokens from the Lockbox and sends to the recipient.
     * - OpL1NativeTokenBridge: Do nothing (the L2 bridge transfers the native tokens to the recipient directly).
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal virtual;

    /**
     * @dev Should transfer `_amount` of tokens from this token router to the fee recipient.
     * @dev Called by `_calculateFeesAndCharge` when fee recipient is set and feeAmount > 0.
     * @dev The default implementation delegates to `_transferTo`, which works for most token routers
     * where tokens are held by the router (e.g., collateral routers, synthetic token routers).
     * @dev Override this function for bridges where tokens are NOT held by the router but fees still
     * need to be paid (e.g., CCTP, Everclear). In those cases, use direct token transfers from the
     * router's balance collected via `_transferFromSender`.
     * Known overrides:
     * - TokenBridgeCctpBase: Directly transfers tokens from router balance.
     * - EverclearTokenBridge: Directly transfers tokens from router balance.
     */
    function _transferFee(
        address _recipient,
        uint256 _amount
    ) internal virtual {
        _transferTo(_recipient, _amount);
    }

    /**
     * @dev Scales local amount to message amount (up by scale factor).
     * Known overrides:
     * - HypERC4626: Scales by exchange rate
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual returns (uint256 _messageAmount) {
        _messageAmount = _localAmount * scale;
    }

    /**
     * @dev Scales message amount to local amount (down by scale factor).
     * Known overrides:
     * - HypERC4626: Scales by exchange rate
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual returns (uint256 _localAmount) {
        _localAmount = _messageAmount / scale;
    }

    /**
     * @notice Handles the incoming transfer message.
     * It decodes the message, emits the ReceivedTransferRemote event, and transfers tokens to the recipient.
     * @param _origin The identifier of the origin chain.
     * @dev param _sender The address of the sender router on the origin chain.
     * @param _message The message data containing recipient and amount.
     * @dev Override this function if custom logic is required for sending out the tokens.
     * Known overrides:
     * - EverclearTokenBridge: Receives the tokens and sends them to the recipient.
     * - EverclearEthBridge: Receives WETH, unwraps it and sends native ETH to the recipient.
     * - HypERC4626: Updates the exchange rate from the metadata
     */
    // solhint-disable-next-line hyperlane/no-virtual-override
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();

        // effects
        emit ReceivedTransferRemote({
            origin: _origin,
            recipient: recipient,
            amountOrId: amount
        });

        // interactions
        _transferTo(recipient.bytes32ToAddress(), _inboundAmount(amount));
    }
}
