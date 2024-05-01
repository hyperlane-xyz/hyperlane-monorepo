// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.5.0;

import "./ISignatureUtils.sol";

interface IAVSDirectory is ISignatureUtils {
    /// @notice Enum representing the status of an operator's registration with an AVS
    enum OperatorAVSRegistrationStatus {
        UNREGISTERED, // Operator not registered to AVS
        REGISTERED // Operator registered to AVS
    }

    /**
     * @notice Called by an avs to register an operator with the avs.
     * @param operator The address of the operator to register.
     * @param operatorSignature The signature, salt, and expiry of the operator's signature.
     */

    function registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) external;

    /**
     * @notice Called by an avs to deregister an operator with the avs.
     * @param operator The address of the operator to deregister.
     */
    function deregisterOperatorFromAVS(address operator) external;

    /**
     * @notice Called by an AVS to emit an `AVSMetadataURIUpdated` event indicating the information has updated.
     * @param metadataURI The URI for metadata associated with an AVS
     * @dev Note that the `metadataURI` is *never stored * and is only emitted in the `AVSMetadataURIUpdated` event
     */
    function updateAVSMetadataURI(string calldata metadataURI) external;
}
