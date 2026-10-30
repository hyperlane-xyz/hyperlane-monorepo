// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

struct Quote {
    address token; // address(0) for the native token, or ERC20 for token payments
    uint256 amount;
}

interface ITokenFee {
    /**
     * @notice Provide the value transfer quote
     * @param _destination The destination domain of the message
     * @param _recipient The message recipient address on `destination`
     * @param _amount The amount to send to the recipient
     * @return quotes Indicate how much of each token to approve and/or send.
     * @dev Good practice is to use the first entry of the quotes for the IGP fee (native or ERC20).
     * @dev Good practice is to use the last entry of the quotes for the token to be transferred.
     * @dev There should not be duplicate `token` addresses in the returned quotes.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view returns (Quote[] memory quotes);
}

interface ITokenBridge is ITokenFee {
    /**
     * @notice Transfer value to another domain
     * @param _destination The destination domain of the message
     * @param _recipient The message recipient address on `destination`
     * @param _amount The amount to send to the recipient
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32);
}

/// @notice A token bridge that can include caller-provided metadata in the warp message.
interface ITokenBridgeWithMetadata is ITokenBridge {
    /// @notice Quotes the transfer using the same metadata that will be sent.
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) external view returns (Quote[] memory quotes);

    /**
     * @notice Transfer value with additional warp message metadata.
     * @dev Metadata is part of the message body, not post-dispatch hook metadata.
     * The destination router determines how it is interpreted.
     * @param _destination The destination domain of the message.
     * @param _recipient The recipient address on the destination.
     * @param _amount The amount to transfer.
     * @param _metadata Additional bytes appended to the token message.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _metadata
    ) external payable returns (bytes32 messageId);
}
