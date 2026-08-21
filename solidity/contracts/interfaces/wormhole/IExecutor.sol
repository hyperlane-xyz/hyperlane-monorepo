// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IExecutorQuoterRouter
 * @notice Shared Wormhole Executor Quoter Router: resolves a delivery
 * provider's quoter key to its on-chain pricing implementation, prices a
 * delivery request, and forwards a paid request to the Executor.
 * @dev Mirrors `wormhole-sdk/interfaces/IExecutor.sol` from Wormhole Solidity
 * SDK v1.1.0. The router is delivery infrastructure only; it never
 * authenticates a message.
 */
interface IExecutorQuoterRouter {
    /**
     * @notice Prices a delivery request through `quoter`.
     * @param dstChain Wormhole chain ID of the destination.
     * @param dstAddr Universal address of the destination contract.
     * @param refundAddr Address credited with any provider-side refund.
     * @param quoter Provider quoter key registered in this router.
     * @param requestBytes Encoded execution request (see `RequestLib`).
     * @param relayInstructions Encoded relay instructions (see `RelayInstructionLib`).
     * @return Native fee that `requestExecution` requires for the same inputs.
     */
    function quoteExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        address quoter,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external view returns (uint256);

    /// @notice Pays for and emits the delivery request priced by `quoteExecution`.
    function requestExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        address quoter,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external payable;
}

/**
 * @title IVaaV1Receiver
 * @notice Destination entrypoint an Executor delivery provider calls with a
 * signed v1 VAA.
 * @dev Permissionless by design: the VAA plus the receiver's own checks are the
 * authorization, never `msg.sender`.
 */
interface IVaaV1Receiver {
    function executeVAAv1(bytes calldata encodedVaa) external payable;
}
