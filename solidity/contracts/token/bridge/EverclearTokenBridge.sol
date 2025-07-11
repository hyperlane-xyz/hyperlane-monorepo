// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {IEverclearAdapter, IEverclear} from "../../interfaces/IEverclearAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

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

    /// @notice The output asset for a given destination domain
    /// @dev Everclear needs to know the output asset address to create intents for cross-chain transfers
    mapping(uint32 destination => bytes32 outputAssets) public outputAssets;

    /// @notice Fee parameters for the bridge operations
    /// @dev The signatures are produced by Everclear and stored here for re-use. We use the same fee for all transfers to all destinations
    IEverclearAdapter.FeeParams public feeParams;

    /// @notice The Everclear adapter contract interface
    /// @dev Immutable reference to the Everclear adapter used for creating intents
    IEverclearAdapter public immutable everclearAdapter;

    /**
     * @notice Emitted when fee parameters are updated
     * @param fee The new fee amount
     * @param deadline The new deadline timestamp for fee validity
     */
    event FeeParamsUpdated(uint256 fee, uint256 deadline);

    /**
     * @notice Emitted when an output asset is configured for a destination
     * @param destination The destination domain ID
     * @param outputAsset The output asset address on the destination chain
     */
    event OutputAssetSet(uint32 destination, bytes32 outputAsset);

    /**
     * @notice Constructor to initialize the Everclear token bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        everclearAdapter = _everclearAdapter;
    }

    /**
     * @notice Initializes the proxy contract.
     * @dev Approves the Everclear adapter to spend tokens
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
        uint256 _fee,
        uint256 _deadline,
        bytes calldata _sig
    ) external onlyOwner {
        feeParams = IEverclearAdapter.FeeParams({
            fee: _fee,
            deadline: _deadline,
            sig: _sig
        });
        emit FeeParamsUpdated(_fee, _deadline);
    }

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
    ) public view override returns (Quote[] memory quotes) {
        _destination; // Keep this to avoid solc's documentation warning (3881)
        _recipient;

        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
        quotes[1] = Quote({
            token: address(wrappedToken),
            amount: _amount + feeParams.fee
        });
    }

    /// @dev We can't use _feeAmount here because Everclear wants to pull tokens from this contract
    /// and the amount from _feeAmount is sent to the fee recipient.
    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 dispatchValue) {
        _amount += feeParams.fee;
        return super._chargeSender(_destination, _recipient, _amount);
    }

    /**
     * @notice Creates an Everclear intent for cross-chain token transfer
     * @dev Internal function to handle intent creation with Everclear adapter
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     */
    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal returns (IEverclear.Intent memory) {
        bytes32 outputAsset = outputAssets[_destination];
        require(outputAsset != bytes32(0), "ETB: Output asset not set");

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        // Create intent
        // We always send the funds to the remote router, which will then send them to the recipient in _handle
        (, IEverclear.Intent memory intent) = everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: _mustHaveRemoteRouter(_destination),
            _inputAsset: address(wrappedToken),
            _outputAsset: outputAsset,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: _getIntentCalldata(_recipient, _amount),
            _feeParams: feeParams
        });

        return intent;
    }

    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (bytes memory) {
        return "";
    }

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256, bytes memory) {
        (uint256 _dispatchValue, bytes memory _msg) = super._beforeDispatch(
            _destination,
            _recipient,
            _amount
        );

        IEverclearAdapter.FeeParams memory _feeParams = feeParams;
        IEverclear.Intent memory intent = _createIntent(
            _destination,
            _recipient,
            _amount
        );

        _msg = bytes.concat(_msg, abi.encode(intent));

        return (_dispatchValue, _msg);
    }

    function _handle(
        uint32 _origin,
        bytes32 /* sender */,
        bytes calldata _message
    ) internal virtual override {
        // Get intent from hyperlane message
        bytes memory metadata = _message.metadata();
        IEverclear.Intent memory intent = abi.decode(
            metadata,
            (IEverclear.Intent)
        );

        // Check that intent is settled
        bytes32 intentId = keccak256(abi.encode(intent));
        require(
            everclearAdapter.spoke().status(intentId) ==
                IEverclear.IntentStatus.SETTLED,
            "ETB: Intent not settled"
        );

        // Get recipient and amount from intent
        bytes32 recipient = intent.receiver;
        uint256 amount = intent.amount;

        // effects
        emit ReceivedTransferRemote(_origin, recipient, amount);

        // Send token to user (interactions)
        _transferTo(recipient.bytes32ToAddress(), _inboundAmount(amount));
    }
}
