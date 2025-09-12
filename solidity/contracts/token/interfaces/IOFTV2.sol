// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IOFTV2
 * @notice Interface for LayerZero V2 OFT (Omnichain Fungible Token) operations
 * @dev Simplified interface focusing on the functions needed for bridging
 */
interface IOFTV2 {
    /**
     * @dev Struct representing token parameters for the OFT send() operation.
     */
    struct SendParam {
        uint32 dstEid; // Destination endpoint ID.
        bytes32 to; // Recipient address.
        uint256 amountLD; // Amount to send in local decimals.
        uint256 minAmountLD; // Minimum amount to send in local decimals.
        bytes extraOptions; // Additional options supplied by the caller.
        bytes composeMsg; // The composed message for the send() operation.
        bytes oftCmd; // The OFT command to be executed.
    }

    /**
     * @dev Struct representing messaging fee information.
     */
    struct MessagingFee {
        uint256 nativeFee; // The native fee.
        uint256 lzTokenFee; // The lzToken fee.
    }

    /**
     * @dev Struct representing messaging receipt information.
     */
    struct MessagingReceipt {
        bytes32 guid; // The unique identifier for the sent message.
        uint64 nonce; // The nonce of the sent message.
        MessagingFee fee; // The LayerZero fee incurred for the message.
    }

    /**
     * @notice Provides a quote for the send() operation.
     * @param _sendParam The parameters for the send() operation.
     * @param _payInLzToken Flag indicating whether the caller is paying in the LZ token.
     * @return fee The calculated LayerZero messaging fee from the send() operation.
     */
    function quoteSend(
        SendParam calldata _sendParam,
        bool _payInLzToken
    ) external view returns (MessagingFee memory fee);

    /**
     * @notice Executes the send() operation.
     * @param _sendParam The parameters for the send operation.
     * @param _fee The fee information supplied by the caller.
     * @param _refundAddress The address to receive any excess funds.
     * @return msgReceipt The LayerZero messaging receipt from the send() operation.
     * @return oftReceipt The OFT receipt information (simplified as bytes32 for messageId).
     */
    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    ) external payable returns (bytes32 msgReceipt, bytes32 oftReceipt);
}