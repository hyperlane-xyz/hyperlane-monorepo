// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {GasRouter} from "../../client/GasRouter.sol";
import {TokenMessage} from "./TokenMessage.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";

/**
 * @title Hyperlane Token Router that extends Router with abstract token (ERC20/ERC721) remote transfer functionality.
 * @author Abacus Works
 */
abstract contract TokenRouter is GasRouter, ITokenBridge {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    /**
     * @dev Emitted on `transferRemote` when a transfer message is dispatched.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens sent in to the remote recipient.
     */
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    /**
     * @dev Emitted on `_handle` when a transfer message is processed.
     * @param origin The identifier of the origin chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens received from the remote sender.
     */
    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    constructor(address _mailbox) GasRouter(_mailbox) {}

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId
    ) external payable virtual returns (bytes32 messageId) {
        return
            _transferRemote(
                _destination,
                _recipient,
                _amountOrId,
                msg.value,
                _GasRouter_hookMetadata(_destination),
                address(hook)
            );
    }

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain with a specified hook
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev The metadata is the token metadata, and is DIFFERENT than the hook metadata.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @param _hookMetadata The metadata passed into the hook
     * @param _hook The post dispatch hook to be called by the Mailbox
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        bytes calldata _hookMetadata,
        address _hook
    ) external payable virtual returns (bytes32 messageId) {
        return
            _transferRemote(
                _destination,
                _recipient,
                _amountOrId,
                msg.value,
                _hookMetadata,
                _hook
            );
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual returns (bytes32 messageId) {
        bytes memory _tokenMetadata = _chargeSender(_amountOrId);

        uint256 outboundAmount = _outboundAmount(_amountOrId);
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            outboundAmount,
            _tokenMetadata
        );

        messageId = _Router_dispatch(
            _destination,
            _value,
            _tokenMessage,
            _hookMetadata,
            _hook
        );

        emit SentTransferRemote(_destination, _recipient, outboundAmount);
    }

    // default behavior is no fee
    function _chargeSender(
        uint256 _amountOrId
    ) internal virtual returns (bytes memory) {
        return _transferFromSender(_amountOrId);
    }

    /**
     * @dev Should return the amount of tokens to be encoded in the message amount (eg for scaling `_localAmount`).
     * @param _localAmount The amount of tokens transferred on this chain in local denomination.
     * @return _messageAmount The amount of tokens to be encoded in the message body.
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual returns (uint256 _messageAmount) {
        _messageAmount = _localAmount;
    }

    /**
     * @dev Should return the amount of tokens to be decoded from the message amount.
     * @param _messageAmount The amount of tokens received in the message body.
     * @return _localAmount The amount of tokens to be transferred on this chain in local denomination.
     */
    function _inboundAmount(
        uint256 _messageAmount
    ) internal view virtual returns (uint256 _localAmount) {
        _localAmount = _messageAmount;
    }

    /**
     * @dev Should transfer `_amountOrId` of tokens from `msg.sender` to this token router.
     * @dev Called by `transferRemote` before message dispatch.
     * @dev Optionally returns `metadata` associated with the transfer to be passed in message.
     */
    function _transferFromSender(
        uint256 _amountOrId
    ) internal virtual returns (bytes memory metadata);

    /**
     * @notice Returns the balance of `account` on this token router.
     * @param account The address to query the balance of.
     * @return The balance of `account`.
     */
    function balanceOf(address account) external virtual returns (uint256);

    /**
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destination The domain of the router.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount of tokens to be sent to the remote recipient.
     * @dev This should be overridden for warp routes that require additional fees/approvals.
     * @return quotes Indicate how much of each token to approve and/or send.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount)
        });
    }

    /**
     * DEPRECATED: Use `quoteTransferRemote` instead.
     * @notice Returns the gas payment required to dispatch a message to the given domain's router.
     * @param _destinationDomain The domain of the router.
     * @dev Assumes bytes32(0) recipient and max amount of tokens for quoting.
     * @return payment How much native value to send in transferRemote call.
     */
    function quoteGasPayment(
        uint32 _destinationDomain
    ) public view virtual override returns (uint256) {
        return
            _quoteGasPayment(_destinationDomain, bytes32(0), type(uint256).max);
    }

    function _quoteGasPayment(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal view returns (uint256) {
        return
            _GasRouter_quoteDispatch(
                _destinationDomain,
                TokenMessage.format(_recipient, _amount),
                address(hook)
            );
    }

    /**
     * @dev Mints tokens to recipient when router receives transfer message.
     * @dev Emits `ReceivedTransferRemote` event on the destination chain.
     * @param _origin The identifier of the origin chain.
     * @param _message The encoded remote transfer message containing the recipient address and amount.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();
        bytes calldata metadata = _message.metadata();
        _transferTo(
            recipient.bytes32ToAddress(),
            _inboundAmount(amount),
            metadata
        );
        emit ReceivedTransferRemote(_origin, recipient, amount);
    }

    /**
     * @dev Should transfer `_amountOrId` of tokens from this token router to `_recipient`.
     * @dev Called by `handle` after message decoding.
     * @dev Optionally handles `metadata` associated with transfer passed in message.
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId,
        bytes calldata metadata
    ) internal virtual;
}
