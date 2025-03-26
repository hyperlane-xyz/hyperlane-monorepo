// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IValueTransferBridge {
    /**
     * @notice Transfer value to another domain
     * @param _destination The destination domain of the message
     * @param _recipient The message recipient address on `destination`
     * @param _amount The amount to send to the recipient
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32);
}
