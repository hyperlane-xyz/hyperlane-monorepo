// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

import {IStrategy} from "./IStrategy.sol";

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

    function getOperatorShares(
        address operator,
        IStrategy[] memory strategies
    ) external view returns (uint256[] memory);
}
