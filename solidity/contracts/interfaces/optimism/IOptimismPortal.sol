// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// author: OP Labs
// copied from https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/interfaces/L1/IOptimismPortal.sol
interface IOptimismPortal {
    struct ProvenWithdrawal {
        bytes32 outputRoot;
        uint128 timestamp;
        uint128 l2OutputIndex;
    }

    struct WithdrawalTransaction {
        uint256 nonce;
        address sender;
        address target;
        uint256 value;
        uint256 gasLimit;
        bytes data;
    }

    struct OutputRootProof {
        bytes32 version;
        bytes32 stateRoot;
        bytes32 messagePasserStorageRoot;
        bytes32 latestBlockhash;
    }

    function proveWithdrawalTransaction(
        WithdrawalTransaction memory _tx,
        uint256 _disputeGameIndex,
        OutputRootProof memory _outputRootProof,
        bytes[] memory _withdrawalProof
    ) external;

    function finalizeWithdrawalTransaction(
        WithdrawalTransaction memory _tx
    ) external;

    function finalizedWithdrawals(
        bytes32 _withdrawalHash
    ) external view returns (bool);

    function provenWithdrawals(
        bytes32 withdrawalHash
    ) external view returns (ProvenWithdrawal memory);
}
