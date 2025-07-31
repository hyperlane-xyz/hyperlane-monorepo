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
 */
contract EverclearTokenBridge is HypERC20Collateral {
    using TokenMessage for bytes;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;

    /// @notice The output asset for a given destination domain
    /// @dev Everclear needs to know the output asset address to create intents for cross-chain transfers
    mapping(uint32 destination => bytes32 outputAssets) public outputAssets;

    /// @notice Whether an intent has been settled
    /// @dev This is used to prevent funds from being sent to a recipient that has already received them
    mapping(bytes32 intentId => bool isSettled) public intentSettled;

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
        address inputAsset,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) HypERC20Collateral(inputAsset, 1, _mailbox) {
        everclearAdapter = _everclearAdapter;
    }

    /**
     * @notice Initializes the proxy contract.
     * @dev Approves the Everclear adapter to spend tokens
     */
    function initialize(address _hook, address _owner) public initializer {
        _MailboxClient_initialize(_hook, address(0), _owner);
        // _LPable_initialize(address(wrappedToken));
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
        uint32 _destination,
        bytes32 _outputAsset
    ) internal {
        _mustHaveRemoteRouter(_destination);
        outputAssets[_destination] = _outputAsset;
        emit OutputAssetSet(_destination, _outputAsset);
    }

    /**
     * @notice Sets the output asset address for a destination domain
     * @dev Only callable by the contract owner
     * @param _outputAssetInfo The output asset information for the destination domain
     */
    function setOutputAsset(
        OutputAssetInfo calldata _outputAssetInfo
    ) external onlyOwner {
        _setOutputAsset(
            _outputAssetInfo.destination,
            _outputAssetInfo.outputAsset
        );
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
            _setOutputAsset(
                _outputAssetInfo.destination,
                _outputAssetInfo.outputAsset
            );
        }
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[2] memory quotes) {
        quotes[0] = Quote({token: address(wrappedToken), amount: _amount});
        quotes[1] = Quote({
            token: address(wrappedToken),
            amount: feeParams.fee
        });
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual returns (bytes32) {
        wrappedToken.safeTransferFrom(
            msg.sender,
            address(this),
            _amount + feeParams.fee
        );

        bytes32 outputAsset = outputAssets[_destination];
        require(outputAsset != bytes32(0), "ETB: Output asset not set");

        // Create everclear intent
        uint32[] memory destinations = new uint32[](1);
        destinations[0] = _destination;

        emit SentTransferRemote(_destination, _recipient, _amount);

        (bytes32 intentId, IEverclear.Intent memory intent) = everclearAdapter
            .newIntent({
                _destinations: destinations,
                _receiver: _recipient,
                _inputAsset: address(wrappedToken),
                _outputAsset: outputAsset,
                _amount: _amount,
                _maxFee: 0,
                _ttl: 0,
                _data: bytes(""),
                _feeParams: feeParams
            });

        return intentId;
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        revert();
    }
}
