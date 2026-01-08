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
     * @notice Emitted when a token gas oracle is set.
     * @param feeToken The fee token address.
     * @param remoteDomain The remote domain.
     * @param gasOracle The gas oracle address.
     */
    event TokenGasOracleSet(
        address indexed feeToken,
        uint32 remoteDomain,
        address gasOracle
    );

    /**
     * @notice Emitted when the gas overhead for a remote domain is set.
     * @param remoteDomain The remote domain.
     * @param gasOverhead The destination gas overhead.
     */
    event DestinationGasOverheadSet(
        uint32 indexed remoteDomain,
        uint256 gasOverhead
    );

    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) external payable;

    /**
     * @notice Pays for gas using an ERC20 token.
     * @param _feeToken The token to pay gas fees in.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the destination chain.
     * @param _gasAmount The amount of destination gas to pay for.
     */
    function payForGas(
        address _feeToken,
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount
    ) external;

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
