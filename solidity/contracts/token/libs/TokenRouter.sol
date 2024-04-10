// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {GasRouter} from "../../client/GasRouter.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenMessage} from "./TokenMessage.sol";

/**
 * @title Hyperlane Token Router that extends Router with abstract token (ERC20/ERC721) remote transfer functionality.
 * @author Abacus Works
 */
abstract contract TokenRouter is GasRouter {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    /**
     * @dev Emitted on `transferRemote` when a transfer message is dispatched.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens burnt on the origin chain.
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
     * @param amount The amount of tokens minted on the destination chain.
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
                bytes(""),
                address(0)
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

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev The metadata is the token metadata, and is DIFFERENT than the hook metadata.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @param _gasPayment The amount of native token to pay for interchain gas.
     * @param _hookMetadata The metadata passed into the hook
     * @param _hook The post dispatch hook to be called by the Mailbox
     * @return messageId The identifier of the dispatched message.
     */
    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _gasPayment,
        bytes memory _hookMetadata,
        address _hook
    ) internal returns (bytes32 messageId) {
        bytes memory metadata = _transferFromSender(_amountOrId);

        if (address(_hook) == address(0)) {
            messageId = _dispatch(
                _destination,
                _gasPayment,
                TokenMessage.format(_recipient, _amountOrId, metadata)
            );
        } else {
            messageId = _dispatch(
                _destination,
                _recipient,
                _gasPayment,
                TokenMessage.format(_recipient, _amountOrId, metadata),
                _hookMetadata,
                IPostDispatchHook(_hook)
            );
        }

        emit SentTransferRemote(_destination, _recipient, _amountOrId);
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
        _transferTo(recipient.bytes32ToAddress(), amount, metadata);
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
