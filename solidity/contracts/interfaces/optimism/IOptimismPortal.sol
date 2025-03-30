// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// author: OP Labs
// copied from https://github.com/ethereum-optimism/optimism/tree/develop/packages/contracts-bedrock
interface IOptimismPortal {
    /// @notice Struct representing a withdrawal transaction.
    /// @custom:field nonce    Nonce of the withdrawal transaction
    /// @custom:field sender   Address of the sender of the transaction.
    /// @custom:field target   Address of the recipient of the transaction.
    /// @custom:field value    Value to send to the recipient.
    /// @custom:field gasLimit Gas limit of the transaction.
    /// @custom:field data     Data of the transaction.
    struct WithdrawalTransaction {
        uint256 nonce;
        address sender;
        address target;
        uint256 value;
        uint256 gasLimit;
        bytes data;
    }

    /// @notice Struct representing the elements that are hashed together to generate an output root
    ///         which itself represents a snapshot of the L2 state.
    /// @custom:field version                  Version of the output root.
    /// @custom:field stateRoot                Root of the state trie at the block of this output.
    /// @custom:field messagePasserStorageRoot Root of the message passer storage trie.
    /// @custom:field latestBlockhash          Hash of the block this output was generated from.
    struct OutputRootProof {
        bytes32 version;
        bytes32 stateRoot;
        bytes32 messagePasserStorageRoot;
        bytes32 latestBlockhash;
    }

    /// @notice Proves a withdrawal transaction.
    /// @param _tx               Withdrawal transaction to finalize.
    /// @param _disputeGameIndex Index of the dispute game to prove the withdrawal against.
    /// @param _outputRootProof  Inclusion proof of the L2ToL1MessagePasser contract's storage root.
    /// @param _withdrawalProof  Inclusion proof of the withdrawal in L2ToL1MessagePasser contract.
    function proveWithdrawalTransaction(
        WithdrawalTransaction memory _tx,
        uint256 _disputeGameIndex,
        OutputRootProof memory _outputRootProof,
        bytes[] memory _withdrawalProof
    ) external;

    /// @notice Finalizes a withdrawal transaction.
    /// @param _tx Withdrawal transaction to finalize.
    function finalizeWithdrawalTransaction(
        WithdrawalTransaction memory _tx
    ) external;

    /// @notice A list of withdrawal hashes which have been successfully finalized.
    function finalizedWithdrawals(
        bytes32 _withdrawalHash
    ) external returns (bool);
}
