// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

/// part of mock interfaces for vendoring necessary Eigenlayer contracts for the hyperlane AVS
/// @author Layr Labs, Inc.

interface IDelegationManager {
    struct OperatorDetails {
        address earningsReceiver;
        address delegationApprover;
        uint32 stakerOptOutWindowBlocks;
    }

    function registerAsOperator(
        OperatorDetails calldata registeringOperatorDetails,
        string calldata metadataURI
    ) external;
}
