// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IL1GatewayRouter
 * @notice Interface for Arbitrum's L1 Gateway Router for ERC20 token bridging
 * @dev See https://github.com/OffchainLabs/token-bridge-contracts
 */
interface IL1GatewayRouter {
    /**
     * @notice Deposit ERC20 tokens from L1 to L2 with custom refund address
     * @param _token L1 address of the ERC20 token
     * @param _refundTo Account to receive excess gas refund on L2
     * @param _to Recipient address on L2
     * @param _amount Amount of tokens to deposit
     * @param _maxGas Max gas for L2 execution
     * @param _gasPriceBid Gas price bid for L2 execution
     * @param _data Encoded: (maxSubmissionCost, callHookData)
     * @return Unique message number of the retryable transaction
     */
    function outboundTransferCustomRefund(
        address _token,
        address _refundTo,
        address _to,
        uint256 _amount,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) external payable returns (bytes memory);

    /**
     * @notice Get the gateway address for a token
     * @param _token L1 token address
     * @return Gateway address for the token
     */
    function getGateway(address _token) external view returns (address);

    /**
     * @notice Get the L2 token address for an L1 token
     * @param _token L1 token address
     * @return L2 token address
     */
    function calculateL2TokenAddress(
        address _token
    ) external view returns (address);
}
