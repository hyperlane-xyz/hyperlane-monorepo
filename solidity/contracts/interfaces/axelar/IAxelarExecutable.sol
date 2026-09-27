// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAxelarGateway} from "./IAxelarGateway.sol";

/**
 * @title IAxelarExecutable
 * @notice Interface for a contract executable by the Axelar Gateway via GMP.
 * @dev Vendored from `@axelar-network/axelar-gmp-sdk-solidity`
 * (contracts/interfaces/IAxelarExecutable.sol).
 */
interface IAxelarExecutable {
    /// @dev Thrown when a function is called with the zero address.
    error InvalidAddress();

    /// @dev Thrown when the call has not been approved by the Axelar Gateway.
    error NotApprovedByGateway();

    /// @notice Returns the Axelar Gateway associated with this executable.
    function gateway() external view returns (IAxelarGateway);

    /**
     * @notice Executes a command delivered from another chain.
     * @param commandId The Axelar command identifier of the delivery.
     * @param sourceChain The Axelar name of the source chain.
     * @param sourceAddress The source contract address (as a string).
     * @param payload The payload to execute.
     */
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external;
}
