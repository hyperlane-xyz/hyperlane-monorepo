// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../Router.sol";

import {ILiquidityLayerRouter} from "../../interfaces/ILiquidityLayerRouter.sol";
import {ICircleMessageTransmitter} from "./interfaces/circle/ICircleMessageTransmitter.sol";
import {ILiquidityLayerAdapter} from "./interfaces/ILiquidityLayerAdapter.sol";
import {ILiquidityLayerMessageRecipient} from "../../interfaces/ILiquidityLayerMessageRecipient.sol";

import {TypeCasts} from "../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LiquidityLayerRouter is Router, ILiquidityLayerRouter {
    using SafeERC20 for IERC20;

    // Token bridge => adapter address
    mapping(string => address) public liquidityLayerAdapters;

    event LiquidityLayerAdapterSet(string indexed bridge, address adapter);

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
    }

    function dispatchWithTokens(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        address _token,
        uint256 _amount,
        string calldata _bridge,
        bytes calldata _messageBody
    ) external returns (bytes32) {
        ILiquidityLayerAdapter _adapter = _getAdapter(_bridge);

        // Transfer the tokens to the adapter
        IERC20(_token).safeTransferFrom(msg.sender, address(_adapter), _amount);

        // Reverts if the bridge was unsuccessful.
        // Gets adapter-specific data that is encoded into the message
        // ultimately sent via Hyperlane.
        bytes memory _adapterData = _adapter.sendTokens(
            _destinationDomain,
            _recipientAddress,
            _token,
            _amount
        );

        // The user's message "wrapped" with metadata required by this middleware
        bytes memory _messageWithMetadata = abi.encode(
            TypeCasts.addressToBytes32(msg.sender),
            _recipientAddress, // The "user" recipient
            _amount, // The amount of the tokens sent over the bridge
            _bridge, // The destination token bridge ID
            _adapterData, // The adapter-specific data
            _messageBody // The "user" message
        );

        // Dispatch the _messageWithMetadata to the destination's LiquidityLayerRouter.
        return _dispatch(_destinationDomain, _messageWithMetadata);
    }

    // Handles a message from an enrolled remote LiquidityLayerRouter
    function _handle(
        uint32 _origin,
        bytes32, // _sender, unused
        bytes calldata _message
    ) internal override {
        // Decode the message with metadata, "unwrapping" the user's message body
        (
            bytes32 _originalSender,
            bytes32 _userRecipientAddress,
            uint256 _amount,
            string memory _bridge,
            bytes memory _adapterData,
            bytes memory _userMessageBody
        ) = abi.decode(
                _message,
                (bytes32, bytes32, uint256, string, bytes, bytes)
            );

        ILiquidityLayerMessageRecipient _userRecipient = ILiquidityLayerMessageRecipient(
                TypeCasts.bytes32ToAddress(_userRecipientAddress)
            );

        // Reverts if the adapter hasn't received the bridged tokens yet
        (address _token, uint256 _receivedAmount) = _getAdapter(_bridge)
            .receiveTokens(
                _origin,
                address(_userRecipient),
                _amount,
                _adapterData
            );

        if (_userMessageBody.length > 0) {
            _userRecipient.handleWithTokens(
                _origin,
                _originalSender,
                _userMessageBody,
                _token,
                _receivedAmount
            );
        }
    }

    function setLiquidityLayerAdapter(string calldata _bridge, address _adapter)
        external
        onlyOwner
    {
        liquidityLayerAdapters[_bridge] = _adapter;
        emit LiquidityLayerAdapterSet(_bridge, _adapter);
    }

    function _getAdapter(string memory _bridge)
        internal
        view
        returns (ILiquidityLayerAdapter _adapter)
    {
        _adapter = ILiquidityLayerAdapter(liquidityLayerAdapters[_bridge]);
        // Require the adapter to have been set
        require(address(_adapter) != address(0), "No adapter found for bridge");
    }
}
