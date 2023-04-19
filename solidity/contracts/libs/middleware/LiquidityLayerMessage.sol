// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../Call.sol";
import {TypeCasts} from "../TypeCasts.sol";

/**
 * Format of message:
 * [   0:  32] Message sender
 * [  32:  64] Token recipient
 * [  64:  96] Token amount
 * [  96:????] Bridge name
 * [????:????] Adapter specific data
 * [????:????] Message body
 */
library LiquidityLayerMessage {
    uint256 private constant SENDER_OFFSET = 0;
    uint256 private constant RECIPIENT_OFFSET = 32;
    uint256 private constant AMOUNT_OFFSET = 64;
    uint256 private constant NAME_OFFSET = 96;

    /**
     * @notice Returns formatted LiquidityLayerMessage
     * @dev This function should only be used in memory message construction.
     * @param _sender Origin chain sender of message
     * @param _recipient Address of recipient on destination chain as bytes32
     * @param _amount The number of tokens to transfer
     * @param _name The name of the bridge to use for transferring tokens
     * @param _body Raw bytes content of message body
     * @return Formatted message body
     */
    function encode(
        address _sender,
        bytes32 _recipient,
        uint256 _amount,
        string calldata _name,
        bytes memory _adapterData,
        bytes calldata _body
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                TypeCasts.addressToBytes32(_sender),
                _recipient,
                _amount,
                _name,
                _adapterData,
                _body
            );
    }

    function decode(bytes calldata _message)
        internal
        pure
        returns (
            string memory,
            bytes memory,
            bytes memory
        )
    {
        return abi.decode(_message[NAME_OFFSET:], (string, bytes, bytes));
    }

    /**
     * @notice Returns the message sender as bytes32.
     * @param _message ABI encoded Hyperlane message.
     * @return Sender of `_message` as bytes32
     */
    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[SENDER_OFFSET:RECIPIENT_OFFSET]);
    }

    /**
     * @notice Returns the message sender as address.
     * @param _message ABI encoded Hyperlane message.
     * @return Sender of `_message` as address
     */
    function senderAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes32ToAddress(sender(_message));
    }

    function recipient(bytes calldata _message)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_message[RECIPIENT_OFFSET:AMOUNT_OFFSET]);
    }

    function recipientAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes32ToAddress(recipient(_message));
    }

    function amount(bytes calldata _message) internal pure returns (uint256) {
        return uint256(bytes32(_message[AMOUNT_OFFSET:NAME_OFFSET]));
    }
}
