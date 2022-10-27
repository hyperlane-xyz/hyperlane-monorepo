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
    uint32 public immutable localDomain;

    mapping(bytes32 => address) tokenBridgeIdAdapters;

    constructor(uint32 _localDomain) {
        // TODO just get this from the outbox
        localDomain = _localDomain;
    }

    function dispatchWithTokens(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody,
        address _token,
        uint256 _amount,
        string calldata _bridge
    ) external payable {
        bytes32 _tokenBridgeId = tokenBridgeId(
            _destinationDomain,
            _token,
            _bridge
        );
        // Get the adapter for the provided destination domain, token, and bridge
        ITokenBridgeAdapter _adapter = ITokenBridgeAdapter(
            tokenBridgeIdAdapters[_tokenBridgeId]
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
            _tokenBridgeId, // The destination token bridge ID
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
            bytes32 _tokenBridgeId, // the ID, where the domain is the local domain
            uint256 _amount,
            bytes memory _adapterData
        ) = abi.decode(
                _message,
                (bytes32, bytes32, bytes, bytes32, uint256, bytes)
            );

        // Get the adapter for the provided local domain, token, and bridge
        ITokenBridgeAdapter _adapter = ITokenBridgeAdapter(
            tokenBridgeIdAdapters[_tokenBridgeId]
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

    function tokenBridgeId(
        uint32 _destinationDomain,
        address _token,
        string calldata _bridge
    ) public view returns (bytes32) {
        bytes memory _encoded = abi.encodePacked(
            _destinationDomain,
            _token,
            _bridge
        );
        return keccak256(_encoded);
    }

    function tokenAndBridgeSupported(
        uint32 _destinationDomain,
        address _token,
        string calldata _bridge
    ) public view returns (bool) {
        bytes32 _id = tokenBridgeId(_destinationDomain, _token, _bridge);
        return tokenBridgeIdAdapters[_id] != address(0);
    }
}
