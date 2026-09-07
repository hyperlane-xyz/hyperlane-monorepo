// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IAxelarGateway
 * @notice Minimal interface for the Axelar Gateway, restricted to the General
 * Message Passing (GMP) surface required by {AxelarHook} and {AxelarIsm}.
 * @dev Vendored from `@axelar-network/axelar-gmp-sdk-solidity`
 * (contracts/interfaces/IAxelarGateway.sol). Function selectors are identical
 * to the deployed Axelar Gateway, so this interface is ABI-compatible with the
 * canonical contracts on every supported chain. Only the methods used by this
 * integration are declared to avoid pulling the full SDK dependency tree.
 */
interface IAxelarGateway {
    /**
     * @notice Emitted when a contract call is made through the gateway.
     */
    event ContractCall(
        address indexed sender,
        string destinationChain,
        string destinationContractAddress,
        bytes32 indexed payloadHash,
        bytes payload
    );

    /**
     * @notice Sends a contract call to another chain.
     * @param destinationChain The Axelar name of the destination chain.
     * @param contractAddress The address of the contract on the destination chain.
     * @param payload The payload to be delivered to the destination contract.
     */
    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes calldata payload
    ) external;

    /**
     * @notice Validates and consumes a contract call approval.
     * @dev Returns true exactly once for an approved (commandId, sourceChain,
     * sourceAddress, msg.sender, payloadHash) tuple, then marks it executed.
     * @return valid True if the contract call was approved by the Axelar network.
     */
    function validateContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external returns (bool valid);

    /**
     * @notice Checks whether a contract call is currently approved.
     */
    function isContractCallApproved(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        address contractAddress,
        bytes32 payloadHash
    ) external view returns (bool);

    /**
     * @notice Checks whether a command has already been executed.
     */
    function isCommandExecuted(bytes32 commandId) external view returns (bool);
}
