// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAxelarGateway} from "./IAxelarGateway.sol";
import {IAxelarExecutable} from "./IAxelarExecutable.sol";

/**
 * @title AxelarExecutable
 * @notice Abstract base for contracts that execute Axelar GMP messages.
 * @dev Vendored verbatim (semantically) from `@axelar-network/axelar-gmp-sdk-solidity`
 * (contracts/executable/AxelarExecutable.sol). Kept in-tree to avoid adding the
 * full Axelar SDK as a build dependency, consistent with how this repo vendors
 * other bridge interfaces (e.g. `interfaces/optimism`). Maintainers who prefer
 * the upstream dependency can replace this file with an import from the SDK
 * without changing {AxelarIsm}, since the surface is identical.
 *
 * `execute` is the untrusted entrypoint: it asks the gateway to validate that
 * the Axelar network approved this exact (commandId, sourceChain, sourceAddress,
 * payloadHash) tuple before dispatching to `_execute`. Authorization of the
 * source is left to the child contract.
 */
abstract contract AxelarExecutable is IAxelarExecutable {
    /// @dev Address of the Axelar Gateway contract.
    address internal immutable gatewayAddress;

    constructor(address gateway_) {
        if (gateway_ == address(0)) revert InvalidAddress();
        gatewayAddress = gateway_;
    }

    /// @inheritdoc IAxelarExecutable
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external {
        bytes32 payloadHash = keccak256(payload);

        if (
            !gateway().validateContractCall(
                commandId,
                sourceChain,
                sourceAddress,
                payloadHash
            )
        ) revert NotApprovedByGateway();

        _execute(commandId, sourceChain, sourceAddress, payload);
    }

    /// @inheritdoc IAxelarExecutable
    function gateway() public view returns (IAxelarGateway) {
        return IAxelarGateway(gatewayAddress);
    }

    /**
     * @dev Executes the gateway-validated command. Implemented by child contracts.
     */
    function _execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal virtual;
}
