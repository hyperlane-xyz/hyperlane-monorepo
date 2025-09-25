// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../interfaces/IEverclearAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {FungibleTokenRouter} from "../libs/FungibleTokenRouter.sol";

/**
 * @notice Information about an output asset for a destination domain
 * @param destination The destination domain ID
 * @param outputAsset The output asset address on the destination chain
 */
struct OutputAssetInfo {
    uint32 destination;
    bytes32 outputAsset;
}

/**
 * @title EverclearTokenBridge
 * @author Hyperlane Team
 * @notice A token bridge that integrates with Everclear's intent-based architecture
 * @dev Extends HypERC20Collateral to provide cross-chain token transfers via Everclear's intent system
 */
contract EverclearTokenBridge is HypERC20Collateral {
    using TokenMessage for bytes;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;

    /**
     * @notice Parameters for creating an Everclear intent
     * @dev This struct is used to avoid stack too deep errors when creating intents
     * @param receiver The address that will receive the tokens on the destination chain
     * @param inputAsset The address of the input token on the source chain
     * @param outputAsset The address of the output token on the destination chain
     * @param amount The amount of tokens to transfer
     * @param feeParams The fee parameters including fee amount, deadline, and signature
     */
    struct IntentParams {
        bytes32 receiver;
        address inputAsset;
        bytes32 outputAsset;
        uint256 amount;
        IEverclearAdapter.FeeParams feeParams;
    }

    /**
     * @notice The output asset for a given destination domain
     * @dev Everclear needs to know the output asset address to create intents for cross-chain transfers
     */
    mapping(uint32 destination => bytes32 outputAsset) public outputAssets;

    /**
     * @notice Whether an intent has been settled
     * @dev This mapping prevents double-spending by tracking which intents have already been processed
     */
    mapping(bytes32 intentId => bool isSettled) public intentSettled;

    /**
     * @notice Fee parameters for bridge operations on each destination domain
     * @dev Contains fee amount, deadline, and signature from Everclear for fee validation
     */
    mapping(uint32 destination => IEverclearAdapter.FeeParams feeParams)
        public feeParams;

    /**
     * @notice The Everclear adapter contract interface
     * @dev Immutable reference to the Everclear adapter used for creating and managing intents
     */
    IEverclearAdapter public immutable everclearAdapter;

    /**
     * @notice The Everclear spoke contract interface
     * @dev Immutable reference used for checking intent status and settlement
     */
    IEverclearSpoke public immutable everclearSpoke;

    /**
     * @notice Emitted when fee parameters are updated
     * @param fee The new fee amount
     * @param deadline The new deadline timestamp for fee validity
     */
    event FeeParamsUpdated(uint32 destination, uint256 fee, uint256 deadline);

    /**
     * @notice Emitted when an output asset is configured for a destination
     * @param destination The destination domain ID
     * @param outputAsset The output asset address on the destination chain
     */
    event OutputAssetSet(uint32 destination, bytes32 outputAsset);

    /**
     * @notice Constructor to initialize the Everclear token bridge
     * @param _erc20 The address of the ERC20 token to be bridged
     * @param _scale The scaling factor for token amounts (typically 1 for 18-decimal tokens)
     * @param _mailbox The address of the Hyperlane mailbox contract
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        everclearAdapter = _everclearAdapter;
        everclearSpoke = _everclearAdapter.spoke();
    }

    /**
     * @notice Initializes the proxy contract
     * @dev Approves the Everclear adapter to spend tokens and calls parent initialization
     * @param _hook The address of the post-dispatch hook (can be zero address)
     * @param _owner The address that will own this contract
     */
    function initialize(address _hook, address _owner) public initializer {
        _HypERC20_initialize(_hook, address(0), _owner);
        wrappedToken.approve(address(everclearAdapter), type(uint256).max);
    }

    /**
     * @notice Sets the fee parameters for Everclear bridge operations
     * @dev Only callable by the contract owner
     * @param _fee The fee amount to charge users for bridge operations
     * @param _deadline The deadline timestamp for fee parameter validity
     * @param _sig The signature for fee validation from Everclear
     */
    function setFeeParams(
        uint32 _destination,
        uint256 _fee,
        uint256 _deadline,
        bytes calldata _sig
    ) external onlyOwner {
        feeParams[_destination] = IEverclearAdapter.FeeParams({
            fee: _fee,
            deadline: _deadline,
            sig: _sig
        });
        emit FeeParamsUpdated(_destination, _fee, _deadline);
    }

    /**
     * @notice Internal function to set the output asset for a destination domain
     * @dev Emits OutputAssetSet event when successful
     * @param _outputAssetInfo The output asset information containing destination and asset address
     */
    function _setOutputAsset(
        OutputAssetInfo calldata _outputAssetInfo
    ) internal {
        uint32 destination = _outputAssetInfo.destination;
        bytes32 outputAsset = _outputAssetInfo.outputAsset;
        outputAssets[destination] = outputAsset;
        emit OutputAssetSet(destination, outputAsset);
    }

    /**
     * @notice Sets the output asset address for a destination domain
     * @dev Only callable by the contract owner
     * @param _outputAssetInfo The output asset information for the destination domain
     */
    function setOutputAsset(
        OutputAssetInfo calldata _outputAssetInfo
    ) external onlyOwner {
        _setOutputAsset(_outputAssetInfo);
    }

    /**
     * @notice Sets multiple output assets in a single transaction for gas efficiency
     * @dev Only callable by the contract owner. Arrays must be the same length
     * @param _outputAssetInfos Array of output asset information for the destination domains
     */
    function setOutputAssetsBatch(
        OutputAssetInfo[] calldata _outputAssetInfos
    ) external onlyOwner {
        uint256 len = _outputAssetInfos.length;

        for (uint256 i = 0; i < len; ++i) {
            OutputAssetInfo calldata _outputAssetInfo = _outputAssetInfos[i];
            _setOutputAsset(_outputAssetInfo);
        }
    }

    /**
     * @notice Provides a quote for transferring tokens to a remote chain
     * @dev Returns the gas payment quote and the total token amount needed (including fees)
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @return quotes Array of quotes containing gas payment and token amount requirements
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public view virtual override returns (Quote[] memory quotes) {
        _destination; // Keep this to avoid solc's documentation warning (3881)
        _recipient;

        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
        quotes[1] = Quote({
            token: address(wrappedToken),
            amount: _amount + feeParams[_destination].fee
        });
    }

    /**
     * @notice Encodes the intent calldata for token transfers
     * @dev Virtual function that can be overridden by derived contracts to include custom data
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @return The encoded calldata (empty in base implementation)
     */
    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal pure virtual returns (bytes memory) {
        return "";
    }

    /**
     * @notice Creates an Everclear intent for cross-chain token transfer
     * @dev Internal function to handle intent creation with Everclear adapter
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @return The created Everclear intent struct containing all transfer details
     */
    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual returns (IEverclear.Intent memory) {
        require(
            outputAssets[_destination] != bytes32(0),
            "ETB: Output asset not set"
        );
        require(
            feeParams[_destination].sig.length > 0,
            "ETB: Fee params not set"
        );

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        // Create intent
        // Packing the intent params in a struct to avoid stack too deep errors
        IntentParams memory intentParams = IntentParams({
            feeParams: feeParams[_destination],
            receiver: _getReceiver(_destination, _recipient),
            inputAsset: address(wrappedToken),
            outputAsset: outputAssets[_destination],
            amount: _amount
        });

        (, IEverclear.Intent memory intent) = everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: intentParams.receiver,
            _inputAsset: intentParams.inputAsset,
            _outputAsset: intentParams.outputAsset,
            _amount: intentParams.amount,
            _maxFee: 0,
            _ttl: 0,
            _data: _getIntentCalldata(_recipient, _amount),
            _feeParams: intentParams.feeParams
        });

        return intent;
    }

    /**
     * @notice Gets the receiver address for an intent
     * @dev Virtual function that can be overridden by derived contracts
     * @param _destination The destination domain ID
     * @param _recipient The intended recipient address
     * @return receiver The receiver address to use in the intent (typically the recipient for token bridge)
     */
    function _getReceiver(
        uint32 _destination,
        bytes32 _recipient
    ) internal view virtual returns (bytes32) {
        return _recipient;
    }

    /**
     * @notice Charges the sender for the transfer including Everclear fees
     * @dev We can't use _feeAmount here because Everclear wants to pull tokens from this contract
     *      and the amount from _feeAmount is sent to the fee recipient.
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer (excluding fees)
     * @return dispatchValue The ETH value to include with the Hyperlane message dispatch
     */
    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 dispatchValue) {
        return
            super._chargeSender(
                _destination,
                _recipient,
                _amount + feeParams[_destination].fee
            );
    }

    /**
     * @notice Handles pre-dispatch logic including charging sender and creating Everclear intent
     * @dev Overrides parent function to integrate with Everclear's intent system
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @return dispatchValue The ETH value to include with the message dispatch
     * @return message The encoded message containing transfer details and intent
     */
    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256, bytes memory) {
        uint256 dispatchValue = _chargeSender(
            _destination,
            _recipient,
            _amount
        );

        IEverclear.Intent memory intent = _createIntent(
            _destination,
            _recipient,
            _amount
        );

        bytes memory message = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount),
            abi.encode(intent)
        );

        return (dispatchValue, message);
    }

    /**
     * @notice Transfers tokens to the recipient (no-op in Everclear bridge)
     * @dev No-op implementation since funds are transferred directly to recipient via Everclear's intent system
     * @param _recipient The address to receive the tokens (unused)
     * @param _amount The amount of tokens to transfer (unused)
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal virtual override {
        // No-op, the funds are transferred directly to `_recipient` via Everclear
    }

    /**
     * @notice Validates the Everclear intent associated with an incoming message
     * @dev Checks that the intent is settled on Everclear and hasn't been processed before
     * @param _message The incoming message containing intent metadata
     * @return intentId The unique identifier for the validated intent
     * @return intentBytes The encoded intent data from the message metadata
     */
    function _validateIntent(
        bytes calldata _message
    ) internal view virtual returns (bytes32, bytes memory) {
        bytes memory intentBytes = _message.metadata();
        bytes32 intentId = keccak256(intentBytes);
        // Check Everclear intent status
        require(
            everclearSpoke.status(intentId) == IEverclear.IntentStatus.SETTLED,
            "ETB: Intent Status != SETTLED"
        );
        // Check that we have not processed this intent before
        require(!intentSettled[intentId], "ETB: Intent already processed");
        return (intentId, intentBytes);
    }

    /**
     * @notice Handles incoming messages from remote chains
     * @dev Validates the Everclear intent, marks it as settled, and delegates to parent handler
     * @param _origin The origin domain ID where the message was sent from
     * @param _sender The address of the sender on the origin chain
     * @param _message The message payload containing transfer details and intent metadata
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        (bytes32 intentId, ) = _validateIntent(_message);
        intentSettled[intentId] = true;
        super._handle(_origin, _sender, _message);
    }
}
