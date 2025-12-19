// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {GasRouter} from "../../client/GasRouter.sol";
import {TokenMessage} from "./TokenMessage.sol";
import {Quote, ITokenBridge, ITokenFee} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "./Quotes.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
    using StandardHookMetadata for bytes;
    using StorageSlot for bytes32;
    using Quotes for Quote[];
    using SafeERC20 for IERC20;

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

    uint256 public immutable scaleNumerator;
    uint256 public immutable scaleDenominator;

    // cannot use compiler assigned slot without
    // breaking backwards compatibility of storage layout
    bytes32 private constant FEE_RECIPIENT_SLOT =
        keccak256("FungibleTokenRouter.feeRecipient");
    bytes32 private constant FEE_HOOK_SLOT = keccak256("TokenRouter.feeHook");

    event FeeRecipientSet(address feeRecipient);
    event FeeHookSet(address feeHook);

    constructor(
        uint256 _scaleNumerator,
        uint256 _scaleDenominator,
        address _mailbox
    ) GasRouter(_mailbox) {
        require(_scaleDenominator > 0, "TokenRouter: denominator cannot be 0");
        scaleNumerator = _scaleNumerator;
        scaleDenominator = _scaleDenominator;
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
        address _feeToken = feeToken();
        quotes = new Quote[](3);
        quotes[0] = Quote({
            token: _feeToken, // address(0) for native, token() for ERC20 payments
            amount: _quoteGasPayment(
                _destination,
                _recipient,
                _amount,
                _feeToken
            )
        });
        (, uint256 feeAmount) = _feeRecipientAndAmount(
            _destination,
            _recipient,
            _amount
        );
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
        return _transferRemote(_destination, _recipient, _amount);
    }

    /// @notice Internal transfer implementation.
    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual returns (bytes32 messageId) {
        address _feeHook = feeHook();
        address _feeToken = feeToken();

        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount,
            msg.value,
            _feeHook
        );

        uint256 scaledAmount = _outboundAmount(_amount);

        // 2. Prepare the token message with the recipient and amount
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            scaledAmount
        );

        messageId = _emitAndDispatch(
            _destination,
            _recipient,
            scaledAmount,
            remainingNativeValue,
            _tokenMessage,
            _feeToken
        );
    }

    // ===========================
    // ========== Internal convenience functions for readability ==========
    // ==========================

    function _calculateFeesAndCharge(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _msgValue,
        address _feeHook
    ) internal returns (uint256 externalFee, uint256 remainingNativeValue) {
        (address _feeRecipient, uint256 feeAmount) = _feeRecipientAndAmount(
            _destination,
            _recipient,
            _amount
        );
        externalFee = _externalFeeAmount(_destination, _recipient, _amount);
        uint256 charge = _amount + feeAmount + externalFee;

        address _token = token();

        // ERC20 fee hook: use token() for gas payments
        if (_feeHook != address(0)) {
            uint256 hookFee = _quoteGasPayment(
                _destination,
                _recipient,
                _amount,
                _token
            );

            // For collateral routers (token() != address(this)), we can add hook fee to charge
            // because _transferFromSender pulls tokens TO the router.
            // For synthetic routers (token() == address(this)), we must pull separately
            // because _transferFromSender burns tokens, so router never receives them.
            if (_token != address(this)) {
                // Collateral router: add hook fee to charge
                charge += hookFee;
            } else {
                // Synthetic router: pull hook fee tokens separately
                IERC20(_token).safeTransferFrom(
                    msg.sender,
                    address(this),
                    hookFee
                );
            }

            // Approve fee hook to pull fee tokens
            IERC20(_token).approve(_feeHook, hookFee);
        }

        _transferFromSender(charge);

        if (feeAmount > 0) {
            // transfer atomically so we don't need to keep track of collateral
            // and fee balances separately
            _transferFee(_feeRecipient, feeAmount);
        }

        // Calculate remaining native value for other hooks
        // When token() is ERC20 (non-native), all native value is available for other hooks
        // When token() is native (address(0)), subtract the charge from msg.value
        remainingNativeValue = _token != address(0)
            ? _msgValue
            : _msgValue - charge;
    }

    // Convenience overload that computes feeHook() internally.
    function _calculateFeesAndCharge(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _msgValue
    ) internal returns (uint256 externalFee, uint256 remainingNativeValue) {
        return
            _calculateFeesAndCharge(
                _destination,
                _recipient,
                _amount,
                _msgValue,
                feeHook()
            );
    }

    // Emits the SentTransferRemote event and dispatches the message with explicit feeToken.
    function _emitAndDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _messageDispatchValue,
        bytes memory _tokenMessage,
        address _feeToken
    ) internal returns (bytes32 messageId) {
        // effects
        emit SentTransferRemote(_destination, _recipient, _amount);

        // interactions
        messageId = _Router_dispatch(
            _destination,
            _messageDispatchValue,
            _tokenMessage,
            _generateHookMetadata(_destination, _feeToken),
            address(hook)
        );
    }

    // Convenience overload that computes feeToken from feeHook().
    function _emitAndDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _messageDispatchValue,
        bytes memory _tokenMessage
    ) internal returns (bytes32 messageId) {
        address _feeToken = feeToken();
        return
            _emitAndDispatch(
                _destination,
                _recipient,
                _amount,
                _messageDispatchValue,
                _tokenMessage,
                _feeToken
            );
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

    /**
     * @notice Initializes the TokenRouter with fee hook configuration.
     * @param _feeHook The fee hook contract address.
     */
    function _TokenRouter_initialize(address _feeHook) internal {
        _setFeeHook(_feeHook);
    }

    /**
     * @notice Sets the fee hook contract address.
     * @param _feeHook The fee hook address.
     */
    function setFeeHook(address _feeHook) external onlyOwner {
        _setFeeHook(_feeHook);
    }

    /**
     * @notice Internal function to set the fee hook address.
     * @param _feeHook The fee hook address.
     */
    function _setFeeHook(address _feeHook) internal {
        FEE_HOOK_SLOT.getAddressSlot().value = _feeHook;
        emit FeeHookSet(_feeHook);
    }

    /**
     * @notice Returns the fee hook contract address.
     * @return The fee hook address.
     */
    function feeHook() public view returns (address) {
        return FEE_HOOK_SLOT.getAddressSlot().value;
    }

    /**
     * @notice Returns the fee token address for gas payments.
     * @return The token address if a fee hook is configured, otherwise address(0) for native payments.
     */
    function feeToken() public view returns (address) {
        return feeHook() != address(0) ? token() : address(0);
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

        Quote[] memory quotes = ITokenFee(_feeRecipient).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
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
     * @return payment How much value to send in transferRemote call (native or feeToken based on config).
     * @dev This function is intended to be overridden by derived contracts that trigger multiple messages.
     * Known overrides:
     * - OPL2ToL1TokenBridgeNative: Quote for two messages (prove and finalize).
     */
    function _quoteGasPayment(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        address _feeToken
    ) internal view virtual returns (uint256) {
        return
            _Router_quoteDispatch(
                _destination,
                TokenMessage.format(_recipient, _amount),
                _generateHookMetadata(_destination, _feeToken),
                address(hook)
            );
    }

    /**
     * @notice Generates hook metadata for dispatch, including feeToken if configured.
     * @param _destination The destination chain.
     * @param _feeToken The fee token address (address(0) for native).
     * @return Hook metadata with the specified feeToken.
     */
    function _generateHookMetadata(
        uint32 _destination,
        address _feeToken
    ) internal view returns (bytes memory) {
        uint256 gasLimit = destinationGas[_destination];
        return
            StandardHookMetadata.formatWithFeeToken(
                0,
                gasLimit,
                msg.sender,
                _feeToken
            );
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
     * @dev Scales local amount to message amount by the scale fraction.
     * Applies: messageAmount = (localAmount * scaleNumerator) / scaleDenominator
     * - If scaleNumerator > scaleDenominator: scales up (e.g., 2/1)
     * - If scaleNumerator < scaleDenominator: scales down (e.g., 1/2)
     * - If scaleNumerator == scaleDenominator: no scaling (e.g., 1/1)
     * Known overrides:
     * - HypERC4626: Scales by exchange rate
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual returns (uint256 _messageAmount) {
        _messageAmount = (_localAmount * scaleNumerator) / scaleDenominator;
    }

    /**
     * @dev Scales message amount to local amount by the inverse scale fraction.
     * Applies: localAmount = (messageAmount * scaleDenominator) / scaleNumerator
     * - If scaleNumerator > scaleDenominator: scales down (e.g., 1/2 for 2/1 outbound)
     * - If scaleNumerator < scaleDenominator: scales up (e.g., 2/1 for 1/2 outbound)
     * - If scaleNumerator == scaleDenominator: no scaling (e.g., 1/1)
     * Known overrides:
     * - HypERC4626: Scales by exchange rate
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual returns (uint256 _localAmount) {
        _localAmount = (_messageAmount * scaleDenominator) / scaleNumerator;
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
        emit ReceivedTransferRemote(_origin, recipient, amount);

        // interactions
        _transferTo(recipient.bytes32ToAddress(), _inboundAmount(amount));
    }
}
