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

interface IExactInFee {
    /**
     * @notice Given a maximum spend budget, return the largest transfer amount
     *         whose amount + fee fits within that budget (exact-in quoting).
     * @param _destination The destination domain of the message
     * @param _recipient The message recipient address on `destination`
     * @param _maxSpend The maximum amount of `token` the sender is willing to
     *        spend on amount + fee combined (gas is quoted separately).
     * @return _amount The largest deliverable amount such that
     *         `_amount + fee(_amount) <= _maxSpend`.
     * @dev Inverse of `ITokenFee.quoteTransferRemote`. Only supported by fee
     *      contracts backed by a monotonic, invertible fee curve.
     */
    function quoteTransferRemoteFrom(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _maxSpend
    ) external view returns (uint256 _amount);
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
