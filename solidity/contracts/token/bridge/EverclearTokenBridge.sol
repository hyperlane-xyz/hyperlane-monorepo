// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {IEverclearAdapter} from "../../interfaces/IEverclearAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IWETH} from "../interfaces/IWETH.sol";

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
contract EverclearTokenBridge is
    ITokenBridge,
    OwnableUpgradeable,
    PackageVersioned
{
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

    IERC20 public immutable token;

    /**
     * @notice Constructor to initialize the Everclear token bridge
     * @param _erc20 The address of the ERC20 token to be used as collateral
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(IERC20 _erc20, IEverclearAdapter _everclearAdapter) {
        token = _erc20;
        everclearAdapter = _everclearAdapter;
    }

    /**
     * @notice Initializes the proxy contract.
     * @dev Approves the Everclear adapter to spend tokens
     */
    function initialize(address _owner) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
        token.approve(address(everclearAdapter), type(uint256).max);
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

        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(token),
            amount: _amount + feeParams.fee
        });
    }

    /**
     * @notice Transfers tokens to a remote chain via Everclear's intent system
     * @dev Creates an Everclear intent for cross-chain transfer. The actual Hyperlane message is sent by Everclear
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @return bytes32(0) as the transfer ID (actual ID is managed by Everclear)
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32) {
        IEverclearAdapter.FeeParams memory _feeParams = feeParams;

        // Charge sender the stored fee
        _transferFrom(msg.sender, address(this), _amount + _feeParams.fee);

        // Create everclear intent
        _createIntent(_destination, _recipient, _amount, _feeParams);

        // A hyperlane message will be sent by everclear internally
        // in a separate transaction. See `EverclearSpokeV3.processIntentQueue`.
        return bytes32(0);
    }

    function _transferFrom(
        address _from,
        address _to,
        uint256 _amount
    ) internal virtual {
        token.safeTransferFrom({from: _from, to: _to, value: _amount});
    }

    /**
     * @notice Creates an Everclear intent for cross-chain token transfer
     * @dev Internal function to handle intent creation with Everclear adapter
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of tokens to transfer
     * @param _feeParams The fee parameters for the intent
     */
    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        IEverclearAdapter.FeeParams memory _feeParams
    ) internal {
        bytes32 outputAsset = outputAssets[_destination];
        require(outputAsset != bytes32(0), "ETB: Output asset not set");

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: _recipient,
            _inputAsset: address(token),
            _outputAsset: outputAsset,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: _getIntentCalldata(_recipient, _amount),
            _feeParams: _feeParams
        });
    }

    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal view virtual returns (bytes memory) {
        return "";
    }
}
