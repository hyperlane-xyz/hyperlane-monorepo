// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/**
 * @title ICrossDomainMessenger interface for bedrock update
 * @dev eth-optimism's version uses strict 0.8.15 which we don't want to restrict to
 */
interface ICrossDomainMessenger {
    /**
     * Sends a cross domain message to the target messenger.
     * @param _target Target contract address.
     * @param _message Message to send to the target.
     * @param _gasLimit Gas limit for the provided message.
     */
    function sendMessage(
        address _target,
        bytes calldata _message,
        uint32 _gasLimit
    ) external payable;

    function relayMessage(
        uint256 _nonce,
        address _sender,
        address _target,
        uint256 _value,
        uint256 _minGasLimit,
        bytes calldata _message
    ) external payable;

    function xDomainMessageSender() external view returns (address);

    function OTHER_MESSENGER() external view returns (address);

    function PORTAL() external view returns (address);

    function baseGas(
        bytes calldata _message,
        uint32 _minGasLimit
    ) external pure returns (uint64);
}

interface IL1CrossDomainMessenger is ICrossDomainMessenger {}

interface IL2CrossDomainMessenger is ICrossDomainMessenger {
    function messageNonce() external view returns (uint256);
}

interface IL2ToL1MessagePasser {
    function messageNonce() external view returns (uint256);
}
