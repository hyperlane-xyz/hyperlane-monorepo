// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IStaticWeightedMultisigIsm is IInterchainSecurityModule {
    struct ValidatorInfo {
        address signingKey;
        uint96 weight;
    }

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @dev Signatures provided to `verify` must be consistent with validator ordering
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return thresholdWeight The total weight of validators needed (out of 10000 basis points)
     */
    function validatorsAndThresholdWeight(
        bytes calldata _message
    )
        external
        view
        returns (ValidatorInfo[] memory validators, uint96 thresholdWeight);
}

interface IWeightedMultisigIsm is IStaticWeightedMultisigIsm {
    function updateValidatorSet(
        ValidatorInfo[] calldata _validators,
        uint96 _thresholdWeight
    ) external;
}
