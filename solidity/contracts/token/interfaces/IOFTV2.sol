// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title LayerZero V2 OFT Interface
 * @notice Interface for LayerZero V2 Omnichain Fungible Tokens
 */
interface IOFTV2 {
    struct SendParam {
        uint32 dstEid;          // Destination endpoint ID
        bytes32 to;             // Recipient address as bytes32
        uint256 amountLD;       // Amount in local decimals
        uint256 minAmountLD;    // Minimum amount to receive
        bytes extraOptions;     // Extra options for LayerZero
        bytes composeMsg;       // Compose message
        bytes oftCmd;           // OFT command
    }

    struct MessagingFee {
        uint256 nativeFee;      // Native fee in ETH/native token
        uint256 lzTokenFee;     // LayerZero token fee
    }

    function send(
        SendParam calldata sendParam,
        MessagingFee calldata fee,
        address refundAddress
    ) external payable returns (bytes32 guid);

    function quoteSend(
        SendParam calldata sendParam,
        bool payInLzToken
    ) external view returns (MessagingFee memory fee);
}