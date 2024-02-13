// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title ERC-3668 Succinct Prover Service Interface
 * @dev See https://eips.ethereum.org/EIPS/eip-3668
 * @dev This interface is not intended to be implemented as a contract.
 * Instead, it is the interface for ProofsService.ts in the ccip-server.
 */
interface ISuccinctProofsService {
    /**
     * Requests the Succinct proof, state proof, and returns account and storage proof
     * @param target contract address to get the proof for
     * @param storageKeys storage keys to get the proof for
     * @param blockNumber block to get the proof for. Will decode as a BigNumber.
     */
    function getProofs(
        address target,
        bytes32[] calldata storageKeys,
        uint256 blockNumber
    ) external view returns (string[][] memory);
}
