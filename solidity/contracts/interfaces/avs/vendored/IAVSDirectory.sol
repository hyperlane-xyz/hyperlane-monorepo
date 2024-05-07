// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.8.0;

import "./ISignatureUtils.sol";

/// part of mock interfaces for vendoring necessary Eigenlayer contracts for the hyperlane AVS
/// @author Layr Labs, Inc.
interface IAVSDirectory is ISignatureUtils {
    enum OperatorAVSRegistrationStatus {
        UNREGISTERED,
        REGISTERED
    }

    event AVSMetadataURIUpdated(address indexed avs, string metadataURI);

    function registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) external;

    function deregisterOperatorFromAVS(address operator) external;

    function updateAVSMetadataURI(string calldata metadataURI) external;
}
