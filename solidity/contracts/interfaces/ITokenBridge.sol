// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

struct Quote {
    address token; // address(0) for the native token
    uint256 amount;
}

interface ITokenFee {
    /**
     * @notice Provide the value transfer quote
     * @param _destination The destination domain of the message
     * @param _recipient The message recipient address on `destination`
     * @param _amount The amount to send to the recipient
     * @return quotes Indicate how much of each token to approve and/or send.
     * @dev Good practice is to use the first entry of the quotes for the native currency (i.e. ETH).
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
     * @dev Emitted on `transferRemote` when a transfer message is dispatched.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amountOrId The amount or ID of tokens sent to the remote recipient.
     */
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amountOrId
    );

    /**
     * @dev Emitted on `_handle` when a transfer message is processed.
     * @param origin The identifier of the origin chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amountOrId The amount or ID of tokens received from the remote sender.
     */
    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amountOrId
    );

    /**
     * @notice Returns the address of the token being bridged.
     * @return The address of the token being bridged.
     */
    function token() external view returns (address);

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
