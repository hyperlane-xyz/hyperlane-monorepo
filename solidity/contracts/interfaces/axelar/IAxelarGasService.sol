// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IAxelarGasService
 * @notice Minimal interface for the Axelar Gas Service, restricted to native
 * gas prepayment for a contract call.
 * @dev Vendored from `@axelar-network/axelar-gmp-sdk-solidity`
 * (contracts/interfaces/IAxelarGasService.sol). The `payNativeGasForContractCall`
 * selector matches the deployed Axelar Gas Service exactly. Surplus gas paid via
 * this method is refunded by Axelar to `refundAddress`, which is why
 * {AxelarHook} can safely over-pay rather than compute an exact on-chain quote.
 */
interface IAxelarGasService {
    /**
     * @notice Pay for gas using native currency for a contract call on a
     * destination chain. Called on the source chain before `callContract`.
     * @param sender The address making the payment (the hook).
     * @param destinationChain The Axelar name of the destination chain.
     * @param destinationAddress The destination contract address (as a string).
     * @param payload The payload passed to `callContract`.
     * @param refundAddress The address that receives any gas over-payment refund.
     */
    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable;
}
