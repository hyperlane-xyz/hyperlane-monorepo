// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

/**
 * @title IInterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of relaying
 * messages to destination chains.
 */
interface IInterchainGasPaymaster {
    /**
     * @notice Emitted when a payment is made for a message's gas costs.
     * @param messageId The ID of the message to pay for.
     * @param destinationDomain The domain of the destination chain.
     * @param gasAmount The amount of destination gas paid for.
     * @param payment The amount of native tokens paid.
     */
    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasAmount,
        uint256 payment
    );
    /**
     * @notice Emitted when value is requested for message recipient.
     * @dev GasPayment emission implies this value was already paid for.
     * @param messageId The ID of the message to pay for.
     * @param value The amount of native tokens to deliver.
     */
    event ValueRequested(bytes32 indexed messageId, uint256 value);

    /**
     * @notice Emitted when the max destination value is set for a remote domain.
     * @param remoteDomain The remote domain.
     * @param maxValue The max destination value allowed (0 = unlimited).
     */
    event MaxDestinationValueSet(uint32 indexed remoteDomain, uint96 maxValue);

    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) external payable;

    function quoteGasPayment(
        uint32 _destinationDomain,
        uint256 _gasAmount
    ) external view returns (uint256);
}
