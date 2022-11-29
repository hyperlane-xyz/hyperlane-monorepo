// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "@hyperlane-xyz/core/contracts/Router.sol";
import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";
import {Message} from "./Message.sol";

/**
 * @title Hyperlane Token that extends the ERC20 token standard to enable native interchain transfers.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
abstract contract TokenRouter is Router {
    using TypeCasts for bytes32;
    using Message for bytes;

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

    /**
     * @notice Transfers `_amount` of tokens from `msg.sender` to `_recipient` on the `_destination` chain.
     * @dev Burns `_amount` of tokens from `msg.sender` on the origin chain and dispatches
     *      message to the `destination` chain to mint `_amount` of tokens to `recipient`.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount of tokens to be sent to the remote recipient.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable {
        _transferFromSender(_amount);
        _dispatchWithGas(
            _destination,
            Message.format(_recipient, _amount),
            msg.value
        );
        emit SentTransferRemote(_destination, _recipient, _amount);
    }

    function _transferFromSender(uint256 _amount) internal virtual;

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
    ) internal override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();
        _transferTo(recipient.bytes32ToAddress(), amount);
        emit ReceivedTransferRemote(_origin, recipient, amount);
    }

    function _transferTo(address _recipient, uint256 _amount) internal virtual;
}
