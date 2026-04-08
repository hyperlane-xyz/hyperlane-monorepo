// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IOFT
 * @notice Minimal interface for LayerZero OFT (Omnichain Fungible Token) contracts.
 * @dev See https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/oapp/contracts/oft/interfaces/IOFT.sol
 */

struct SendParam {
    uint32 dstEid; // Destination LayerZero endpoint ID
    bytes32 to; // Recipient address
    uint256 amountLD; // Amount in local decimals
    uint256 minAmountLD; // Minimum amount accepted (slippage protection)
    bytes extraOptions; // Additional LayerZero messaging options
    bytes composeMsg; // Optional composed message
    bytes oftCmd; // OFT command (unused in default implementations)
}

struct MessagingFee {
    uint256 nativeFee; // Gas fee in native token
    uint256 lzTokenFee; // Optional fee in ZRO token
}

struct MessagingReceipt {
    bytes32 guid; // Globally unique message identifier
    uint64 nonce; // Message nonce
    MessagingFee fee; // Actual fee paid
}

struct OFTLimit {
    uint256 minAmountLD;
    uint256 maxAmountLD;
}

struct OFTFeeDetail {
    int256 feeAmountLD; // Fee in local decimals (token-denominated)
    string description;
}

struct OFTReceipt {
    uint256 amountSentLD; // Amount debited from sender
    uint256 amountReceivedLD; // Amount credited on destination
}

interface IOFT {
    function oftVersion()
        external
        view
        returns (bytes4 interfaceId, uint64 version);

    function token() external view returns (address);

    function approvalRequired() external view returns (bool);

    function sharedDecimals() external view returns (uint8);

    function quoteOFT(
        SendParam calldata _sendParam
    )
        external
        view
        returns (
            OFTLimit memory limit,
            OFTFeeDetail[] memory oftFeeDetails,
            OFTReceipt memory receipt
        );

    function quoteSend(
        SendParam calldata _sendParam,
        bool _payInLzToken
    ) external view returns (MessagingFee memory msgFee);

    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    )
        external
        payable
        returns (
            MessagingReceipt memory msgReceipt,
            OFTReceipt memory oftReceipt
        );
}
