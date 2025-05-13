// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// author: OP Labs
// copied from https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/interfaces/L1/IOptimismPortal.sol
interface IOptimismPortal2 {
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

    struct ProvenWithdrawal {
        address disputeGameProxy;
        uint64 timestamp;
    }

    function provenWithdrawals(
        bytes32 withdrawalHash,
        address msgSender
    ) external view returns (ProvenWithdrawal memory);
}
