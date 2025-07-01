// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {IEverclearAdapter} from "../../interfaces/IEverclearAdapter.sol";

/**
 * @title EverclearTokenBridge
 * @author Hyperlane Team
 * @notice A token bridge that integrates with Everclear's intent-based architecture
 * @dev Extends HypERC20Collateral to provide cross-chain token transfers via Everclear's intent system
 */
contract EverclearTokenBridge is HypERC20Collateral {
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
     * @param erc20 The address of the ERC20 token to be used as collateral
     * @param _scale The scaling factor for token amounts
     * @param _mailbox The address of the Hyperlane mailbox contract
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) HypERC20Collateral(erc20, _scale, _mailbox) {
        everclearAdapter = _everclearAdapter;
    }

    /**
     * @notice Initializes the contract with required parameters
     * @dev Sets up the mailbox client and approves the Everclear adapter to spend tokens
     * @param _hook The address of the post-dispatch hook contract
     * @param _interchainSecurityModule The address of the interchain security module
     * @param _owner The address that will own this contract
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
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

    /**
     * @notice Sets the output asset address for a destination domain
     * @dev Only callable by the contract owner
     * @param _destination The destination domain ID
     * @param _outputAsset The output asset address on the destination chain (as bytes32)
     */
    function setOutputAsset(
        uint32 _destination,
        bytes32 _outputAsset
    ) external onlyOwner {
        outputAssets[_destination] = _outputAsset;
        emit OutputAssetSet(_destination, _outputAsset);
    }

    /**
     * @notice Sets multiple output assets in a single transaction for gas efficiency
     * @dev Only callable by the contract owner. Arrays must be the same length
     * @param _destinations Array of destination domain IDs
     * @param _outputAssets Array of output asset addresses on destination chains
     */
    function setOutputAssetsBatch(
        uint32[] calldata _destinations,
        bytes32[] calldata _outputAssets
    ) external onlyOwner {
        uint256 len = _destinations.length;
        require(
            _destinations.length == _outputAssets.length,
            "ETB: Length mismatch"
        );

        for (uint256 i = 0; i < len; ) {
            outputAssets[_destinations[i]] = _outputAssets[i];
            emit OutputAssetSet(_destinations[i], _outputAssets[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Checks if an output asset is configured for a destination
     * @param _destination The destination domain ID to check
     * @return True if output asset is set for the destination, false otherwise
     */
    function isOutputAssetSet(
        uint32 _destination
    ) external view returns (bool) {
        return outputAssets[_destination] != bytes32(0);
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

        // Charge sender for the fee
        _transferFromSender(_amount + _feeParams.fee);

        // Create everclear intent
        _createIntent(_destination, _recipient, _amount, _feeParams);

        // A hyperlane message will be sent by everclear internally
        // in a separate transaction. See `EverclearSpokeV3.processIntentQueue`.
        return bytes32(0);
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

        // Check that the fee params are still valid
        // This will also revert if the feeParams are not set
        require(
            _feeParams.deadline > block.timestamp,
            "ETB: Fee params deadline expired"
        );

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        everclearAdapter.newIntent({
            _destinations: destinations,
            _receiver: _recipient,
            _inputAsset: address(wrappedToken),
            _outputAsset: outputAsset,
            _amount: _amount,
            _maxFee: 0,
            _ttl: 0,
            _data: "",
            _feeParams: _feeParams
        });
    }
}
