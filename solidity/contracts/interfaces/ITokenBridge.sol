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
     * @dev Good practice is to use the first entry of the quotes for the native currency (i.e. ETH)
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
