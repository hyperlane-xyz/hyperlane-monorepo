// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IGasOracle} from "./IGasOracle.sol";

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
     * @param payment The amount of tokens paid.
     */
    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasAmount,
        uint256 payment
    );

    /**
     * @notice Emitted when token destination gas config is set.
     * @param feeToken The fee token address.
     * @param remoteDomain The remote domain.
     * @param gasOracle The gas oracle address.
     * @param gasOverhead The gas overhead.
     */
    event TokenDestinationGasConfigSet(
        address indexed feeToken,
        uint32 remoteDomain,
        address gasOracle,
        uint96 gasOverhead
    );

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

    /**
     * @notice Quotes the amount of a specific token required to pay for gas.
     * @param _feeToken The token to pay gas fees in.
     * @param _destinationDomain The domain of the destination chain.
     * @param _gasAmount The amount of destination gas to pay for.
     * @return The amount of tokens required.
     */
    function quoteGasPayment(
        address _feeToken,
        uint32 _destinationDomain,
        uint256 _gasAmount
    ) external view returns (uint256);

    /**
     * @notice Claims collected tokens to the beneficiary.
     * @param _token The token to claim.
     */
    function claimToken(address _token) external;
}
