// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../Router.sol";

import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";
import {ICircleBridge} from "./interfaces/circle/ICircleBridge.sol";
import {ICircleMessageTransmitter} from "./interfaces/circle/ICircleMessageTransmitter.sol";
import {ITokenBridgeAdapter} from "./interfaces/ITokenBridgeAdapter.sol";
import {ITokenBridgeMessageRecipient} from "./interfaces/ITokenBridgeMessageRecipient.sol";

import {TypeCasts} from "../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TokenBridgeRouter is Router {
    // Token bridge => adapter address
    mapping(string => address) public tokenBridgeAdapters;

    event TokenBridgeAdapterSet(string indexed bridge, address adapter);

    function initialize(
        address _owner,
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);
        // Set the addresses for the ACM and IGP
        // Alternatively, this could be done later in an initialize method
        _setAbacusConnectionManager(_abacusConnectionManager);
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }

    function dispatchWithTokens(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody,
        address _token,
        uint256 _amount,
        string calldata _bridge
    ) external payable {
        // Get the adapter for the provided destination domain, token, and bridge
        ITokenBridgeAdapter _adapter = ITokenBridgeAdapter(
            tokenBridgeAdapters[_bridge]
        );
        // Require the adapter to have been set
        require(address(_adapter) != address(0), "!adapter");

        // Transfer the tokens to the adapter
        // TODO: use safeTransferFrom
        require(
            IERC20(_token).transferFrom(msg.sender, address(_adapter), _amount),
            "!transfer in"
        );

        // Reverts if the bridge was unsuccessful.
        // Gets adapter-specific data that is encoded into the message
        // ultimately sent via Hyperlane.
        bytes memory _adapterData = _adapter.bridgeToken(
            _destinationDomain,
            _recipientAddress,
            _token,
            _amount
        );

        // The user's message "wrapped" with metadata required by this middleware
        bytes memory _messageWithMetadata = abi.encode(
            TypeCasts.addressToBytes32(msg.sender),
            _recipientAddress, // The "user" recipient
            _messageBody, // The "user" message
            _bridge, // The destination token bridge ID
            _amount, // The amount of the tokens sent over the bridge
            _adapterData // The adapter-specific data
        );

        // Dispatch the _messageWithMetadata to the destination's TokenBridgeRouter.
        _dispatchWithGas(_destinationDomain, _messageWithMetadata, msg.value);
    }

    // Handles a message from an enrolled remote TokenBridgeRouter
    function _handle(
        uint32 _origin,
        bytes32, // _sender, unused
        bytes calldata _message
    ) internal override {
        // Decode the message with metadata, "unwrapping" the user's message body
        (
            bytes32 _originalSender,
            bytes32 _userRecipientAddress,
            bytes memory _userMessageBody,
            string memory _bridge,
            uint256 _amount,
            bytes memory _adapterData
        ) = abi.decode(
                _message,
                (bytes32, bytes32, bytes, string, uint256, bytes)
            );

        // Get the adapter for the provided local domain, token, and bridge
        ITokenBridgeAdapter _adapter = ITokenBridgeAdapter(
            tokenBridgeAdapters[_bridge]
        );
        // Require the adapter to have been set
        require(address(_adapter) != address(0), "!adapter");

        ITokenBridgeMessageRecipient _userRecipient = ITokenBridgeMessageRecipient(
                TypeCasts.bytes32ToAddress(_userRecipientAddress)
            );

        // Reverts if the adapter hasn't received the bridged tokens yet
        (address _token, uint256 _sentAmount) = _adapter.sendBridgedTokens(
            _origin,
            address(_userRecipient),
            _adapterData,
            _amount
        );

        _userRecipient.handleWithTokens(
            _origin,
            _originalSender,
            _userMessageBody,
            _token,
            _sentAmount
        );
    }

    function setTokenBridgeAdapter(string calldata _bridge, address _adapter)
        external
        onlyOwner
    {
        tokenBridgeAdapters[_bridge] = _adapter;
        emit TokenBridgeAdapterSet(_bridge, _adapter);
    }
}
