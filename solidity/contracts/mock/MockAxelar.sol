// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAxelarGateway} from "../interfaces/axelar/IAxelarGateway.sol";
import {IAxelarGasService} from "../interfaces/axelar/IAxelarGasService.sol";

/**
 * @title MockAxelarGateway
 * @notice Minimal test double for the Axelar Gateway.
 * @dev Mirrors the real gateway's contract-call lifecycle closely enough to
 * exercise {AxelarHook} and {AxelarIsm}:
 *  - `callContract` is a no-op that emits `ContractCall` (asserted with vm.expectCall).
 *  - `approveContractCall` (test-only) registers an approval, simulating the
 *    Axelar network having approved a delivery.
 *  - `validateContractCall` returns true once per approval (keyed on the calling
 *    contract, i.e. the ISM) and then marks it executed, matching mainnet semantics.
 */
contract MockAxelarGateway is IAxelarGateway {
    mapping(bytes32 => bool) public approvals;
    mapping(bytes32 => bool) public executed;

    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes calldata payload
    ) external override {
        emit ContractCall(
            msg.sender,
            destinationChain,
            contractAddress,
            keccak256(payload),
            payload
        );
    }

    /// @notice Test helper: register an approval for a future `validateContractCall`.
    function approveContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        address contractAddress,
        bytes32 payloadHash
    ) external {
        approvals[
            _key(
                commandId,
                sourceChain,
                sourceAddress,
                contractAddress,
                payloadHash
            )
        ] = true;
    }

    function validateContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external override returns (bool) {
        bytes32 key = _key(
            commandId,
            sourceChain,
            sourceAddress,
            msg.sender,
            payloadHash
        );
        if (approvals[key]) {
            approvals[key] = false;
            executed[commandId] = true;
            return true;
        }
        return false;
    }

    function isContractCallApproved(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        address contractAddress,
        bytes32 payloadHash
    ) external view override returns (bool) {
        return
            approvals[
                _key(
                    commandId,
                    sourceChain,
                    sourceAddress,
                    contractAddress,
                    payloadHash
                )
            ];
    }

    function isCommandExecuted(
        bytes32 commandId
    ) external view override returns (bool) {
        return executed[commandId];
    }

    function _key(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        address contractAddress,
        bytes32 payloadHash
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    commandId,
                    sourceChain,
                    sourceAddress,
                    contractAddress,
                    payloadHash
                )
            );
    }
}

/**
 * @title MockAxelarGasService
 * @notice Minimal test double for the Axelar Gas Service.
 * @dev Accepts and retains the native gas pre-payment (so the hook forwards its
 * entire balance here, leaving nothing to refund on-chain) and emits an event
 * for `vm.expectCall`/`vm.expectEmit` assertions.
 */
contract MockAxelarGasService is IAxelarGasService {
    event NativeGasPaidForContractCall(
        address indexed sender,
        string destinationChain,
        string destinationAddress,
        bytes32 indexed payloadHash,
        uint256 gasFeeAmount,
        address refundAddress
    );

    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable override {
        emit NativeGasPaidForContractCall(
            sender,
            destinationChain,
            destinationAddress,
            keccak256(payload),
            msg.value,
            refundAddress
        );
    }
}
