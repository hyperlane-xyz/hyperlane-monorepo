// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../interfaces/IEverclearAdapter.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {ERC20Collateral, WETHCollateral} from "../libs/TokenCollateral.sol";

import {LpCollateralRouterStorage} from "../libs/LpCollateralRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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
 * @title EverclearBridge
 * @author Hyperlane Team
 * @notice A token bridge that integrates with Everclear's intent-based architecture
 */
abstract contract EverclearBridge is TokenRouter {
    using TokenMessage for bytes;
    using TypeCasts for bytes32;

    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

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

    IERC20 public immutable wrappedToken;

    /// @notice The Everclear adapter contract interface
    /// @dev Immutable reference to the Everclear adapter used for creating intents
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
        IEverclearAdapter _everclearAdapter,
        IERC20 _erc20,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        wrappedToken = _erc20;
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
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: address(0),
            _owner: _owner
        });
        wrappedToken.approve(address(everclearAdapter), type(uint256).max);
    }

    function _settleIntent(bytes calldata _message) internal virtual {
        /* CHECKS */
        // Check that intent is settled
        bytes32 intentId = keccak256(_message.metadata());
        require(
            everclearSpoke.status(intentId) == IEverclear.IntentStatus.SETTLED,
            "ETB: Intent Status != SETTLED"
        );
        // Check that we have not processed this intent before
        require(!intentSettled[intentId], "ETB: Intent already processed");

        /* EFFECTS */
        intentSettled[intentId] = true;
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
        emit FeeParamsUpdated({
            destination: _destination,
            fee: _fee,
            deadline: _deadline
        });
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
     * @inheritdoc TokenRouter
     */
    function _externalFeeAmount(
        uint32 _destination,
        bytes32,
        uint256
    ) internal view override returns (uint256 feeAmount) {
        return feeParams[_destination].fee;
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to create an Everclear intent for the transfer.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount,
            _msgValue: msg.value
        });

        // 2. Prepare the token message with the recipient, amount, and any additional metadata in overrides
        IEverclear.Intent memory intent = _createIntent({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _amount
        });

        uint256 scaledAmount = _outboundAmount(_amount);

        bytes memory _tokenMessage = TokenMessage.format({
            _recipient: _recipient,
            _amount: scaledAmount,
            _metadata: abi.encode(intent)
        });

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

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to check for the Everclear intent status and transfer tokens to the recipient.
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        _settleIntent(_message);
        super._handle(_origin, _sender, _message);
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
    ) internal pure virtual returns (bytes memory);

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
    ) internal view virtual returns (bytes32 receiver);
}

/**
 * @title EverclearTokenBridge
 * @author Hyperlane Team
 * @notice A token bridge that integrates with Everclear's intent-based architecture
 * @dev Extends HypERC20Collateral to provide cross-chain token transfers via Everclear's intent system
 */
contract EverclearTokenBridge is EverclearBridge {
    using ERC20Collateral for IERC20;

    /**
     * @notice Constructor to initialize the Everclear token bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) EverclearBridge(_everclearAdapter, IERC20(_erc20), _scale, _mailbox) {}

    /**
     * @inheritdoc EverclearBridge
     */
    function _getReceiver(
        uint32 /* _destination */,
        bytes32 _recipient
    ) internal pure override returns (bytes32 receiver) {
        return _recipient;
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken._transferFromSender(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // Do nothing (tokens transferred to recipient directly)
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Transfers fees directly from router balance using ERC20 transfer.
     */
    function _transferFee(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken._transferTo(_recipient, _amount);
    }

    /**
     * @notice Encodes the intent calldata for ETH transfers
     * @return The encoded calldata for the everclear intent.
     */
    function _getIntentCalldata(
        bytes32 /* _recipient */,
        uint256 /* _amount */
    ) internal pure override returns (bytes memory) {
        return "";
    }
}

/**
 * @title EverclearEthBridge
 * @author Hyperlane Team
 * @notice A specialized ETH bridge that integrates with Everclear's intent-based architecture
 * @dev Extends EverclearTokenBridge to handle ETH by wrapping to WETH for transfers and unwrapping on destination
 */
contract EverclearEthBridge is EverclearBridge {
    using WETHCollateral for IWETH;
    using TokenMessage for bytes;
    using SafeERC20 for IERC20;
    using Address for address payable;
    using TypeCasts for bytes32;

    uint256 private constant SCALE = 1;

    /**
     * @notice Constructor to initialize the Everclear ETH bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        IWETH _weth,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) EverclearBridge(_everclearAdapter, IERC20(_weth), SCALE, _mailbox) {}

    /**
     * @inheritdoc EverclearBridge
     */
    function _getReceiver(
        uint32 _destination,
        bytes32 /* _recipient */
    ) internal view override returns (bytes32 receiver) {
        return _mustHaveRemoteRouter(_destination);
    }

    // senders and recipients are ETH, so we return address(0)
    /**
     * @inheritdoc TokenRouter
     */
    function token() public pure override returns (address) {
        return address(0);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        IWETH(address(wrappedToken))._transferFromSender(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        IWETH(address(wrappedToken))._transferTo(_recipient, _amount);
    }

    /**
     * @notice Allows the contract to receive ETH
     * @dev Required for WETH unwrapping functionality
     */
    receive() external payable {
        require(
            msg.sender == address(wrappedToken),
            "EEB: Only WETH can send ETH"
        );
    }

    /**
     * @notice Encodes the intent calldata for ETH transfers
     * @dev Overrides parent to encode recipient and amount for ETH-specific intent validation
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of ETH to transfer
     * @return The encoded calldata containing recipient and amount
     */
    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal pure override returns (bytes memory) {
        return abi.encode(_recipient, _amount);
    }

    /**
     * @notice Validates the Everclear intent for ETH transfers
     * @dev Overrides parent to add ETH-specific validation by checking intent data matches message
     * @param _message The incoming message containing transfer details
     */
    function _settleIntent(bytes calldata _message) internal override {
        super._settleIntent(_message);

        IEverclear.Intent memory intent = abi.decode(
            _message.metadata(),
            (IEverclear.Intent)
        );
        (bytes32 _intentRecipient, uint256 _intentAmount) = abi.decode(
            intent.data,
            (bytes32, uint256)
        );

        require(
            _intentRecipient == _message.recipient(),
            "EEB: Intent recipient mismatch"
        );
        require(
            _intentAmount == _message.amount(),
            "EEB: Intent amount mismatch"
        );
    }
}
