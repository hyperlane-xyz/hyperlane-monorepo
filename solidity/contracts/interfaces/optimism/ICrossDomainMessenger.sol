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
}
