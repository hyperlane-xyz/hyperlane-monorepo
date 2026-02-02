// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IInbox
 * @notice Interface for Arbitrum's Inbox contract for native ETH deposits
 * @dev See https://github.com/OffchainLabs/nitro-contracts/blob/main/src/bridge/IInbox.sol
 */
interface IInbox {
    /**
     * @notice Deposit ETH from L1 to L2
     * @dev This does NOT trigger the fallback function on the recipient
     * @param destAddr The destination address on L2
     * @return messageNumber The unique message number for this deposit
     */
    function depositEth(address destAddr) external payable returns (uint256);
}
